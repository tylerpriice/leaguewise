import { rosterTotals } from './draft-engine.js';
import { competitionRanks } from './rank-engine.js';

// PURE. No DOM, no AppState, no fetches. Stat tables arrive as ARGUMENTS rather than imports, which is the same choice rank-engine.js and draft-engine.js already made and for the same reason: an engine that knows which ids are rates knows one sport, and every one of these functions has to work for both. --------------------------------------------------------------------------------------------- WHAT A RETRO SEASON IS, AND WHAT IT IS NOT --------------------------------------------------------------------------------------------- "How would this player have done in 2023 in my league" has no scalar answer. A categories league produces no season number - it produces standings against opponents, and in 2023 this league had none, because it did not exist. The only honest answer is WHERE THE PLAYER RANKED, in this league's categories, against everyone who actually played that season. So this file builds a BASIS - the pool, grouped and totalled - and hands it to the UNCHANGED rank engine. Not a parallel scorer. That is the one-value-engine ruling: the retro number and the season tab agree about a player by construction rather than by anyone remembering to keep two implementations in step. --------------------------------------------------------------------------------------------- THE FOUR TRAPS, EACH HANDLED WHERE IT BITES --------------------------------------------------------------------------------------------- 1. ELIGIBILITY IS THAT SEASON'S, NEVER TODAY'S. A player's positions drift year to year - a shortstop becomes an outfielder, a winger becomes a centre - and ranking a 2023 season inside 2026's slot map is quietly wrong in a way nothing on screen would reveal. Each player carries the eligibleSlots the historical pool gave, and this file never consults a current one. 2. RATES COME FROM COMPONENTS. A season's batting average is its hits over its at-bats, summed first. ESPN's own precomputed rate rides along in the line and is DELIBERATELY OVERWRITTEN here, because a windowed or partial-season figure has to be rebuilt the same way the rest of the app rebuilds one, and two routes to one number is how they drift. 3. GROUP MEMBERSHIP IS ELIGIBILITY FIRST, THEN FIGURES. Both halves are needed and each one alone is wrong. Figures alone put every goalie in the skater group - MEASURED on the real 2025 pool, where all 102 of them landed there and were reported as two-way players - because a goalie's line genuinely carries assists and points. Eligibility alone puts a batter in the pitcher pool, reading as zeros in every pitching category and ranking last among arms, subtracting value that was never lost. So: eligible for one of that group's slots THAT SEASON, and carrying at least one of its categories. 4. TWO-WAY PLAYERS ARE IN BOTH GROUPS, and 2023 is exactly the season where forgetting that zeroes half of the most famous player in the sport. This file puts them in both lists; the above-replacement-only combination rule is draft-engine's sumOfEdgesAcross, unchanged. --------------------------------------------------------------------------------------------- AND ONE THING THIS FILE WILL NOT PRODUCE --------------------------------------------------------------------------------------------- No value number. Rank and per-category percentiles only. phase 2 may change what Value means for a categories league, and a 2023 season that read one number today and a different one tomorrow - for a season that cannot itself change - would be indefensible. Rank and percentiles are engine outputs that survive that ruling untouched, which is why the frozen retro-seasons contract carries those and nothing else.

// ==== One player's season line ====

// A historical stat line turned into the seasonTotals the rank engine reads. The raw counting stats pass through as they are. Every rate the league scores is then RECOMPUTED from its own components and written over whatever the source said, which is trap 2. A rate whose components are missing is left ABSENT rather than zeroed - a pitcher with no innings has no earned-run average, which is a different statement from having one of zero, and in an inverse category a zero is the best possible figure.
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

// Does this player carry any of these categories at all? Trap 3's test, and the reason it asks about ABSENCE rather than about zero: a real zero is evidence, a missing key is not.
export function carriesAny(totals, categoryIds) {
    return (categoryIds || []).some(id => {
        const v = (totals || {})[String(id)];
        return v !== undefined && v !== null;
    });
}

// ==== The basis ====

// A whole historical season, grouped and totalled, ready for computeRotoRanks. pool: [{ id, name, defaultPositionId, eligibleSlots, line }] - THAT season's own pool opts: categoryIds the league's scored ids, today's settings applied to that season secondaryStatIds Set of ids belonging to the secondary group (pitching / goaltending) secondarySlots Set of lineup slots that are secondary-role (SECONDARY_LINEUP_SLOTS) nonStartingSlots Set of bench and injury slots, which everybody is eligible for and which therefore say nothing about anybody's role rateSpecs the sport's RATE_COMPONENTS rows gamesIds { primary, secondary } - the games-played id per group Returns both groups, the two-way players named, and everyone it could not place with a reason, because a pool that silently loses a third of itself looks exactly like one that did not.
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
            // Trap 1: this season's own eligibility, carried untouched.
            defaultPositionId: p.defaultPositionId,
            eligibleSlots: p.eligibleSlots || [],
            seasonTotals: totals
        };
        // Eligibility for a group's slots, read off THIS season's pool. Bench and injury slots are excluded because everybody is eligible for them - they are where a roster puts a player, not what they are - so counting them would make every player eligible everywhere.
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

// Which players were eligible at a slot THAT season. A surface filtering the band by position asks this rather than reaching for the current pool, which is trap 1 in the one place it is easiest to get wrong: the filter, long after the ranking is done and looking harmless.
export function eligibleAt(basisGroup, slotId) {
    const slot = Number(slotId);
    return (basisGroup || []).filter(p => (p.eligibleSlots || []).includes(slot));
}

// ==== From the engine's answer to the frozen contract ====

// One season row for one player, in the shape tests/fixtures/retro-seasons.md specifies. result: whatever computeRotoRanks returned for this player's GROUP that season returns: { seasonId, rank, total, tied, games, percentiles } - or null THE THREE OUTCOMES ARE DIFFERENT AND THE CONTRACT KEEPS THEM DIFFERENT: - not in the pool at all -> null, and the caller omits the season. A rookie did not rank last, nobody ranked, and a row of zeros would say otherwise. - in the pool, not ranked -> rank null, percentiles {}, a real games count. The engine's playing-time gate gives a player a season and no standing in it. - ranked -> everything, plus whether the rank is shared. RANKS ARE COMPETITION RANKS, not the engine's raw ordering. computeRotoRanks hands back positions 1..n by sort order, so three players on identical scores come out first, second and third; the app's own rule (competitionRanks) is that they are all first, and the band renders T1. Getting this from the sorted scores rather than the index is the whole reason `tied` can be in the contract at all.
export function seasonRowFrom(result, playerId, { seasonId, games } = {}) {
    if (!result) return null;
    const scores = result.scores instanceof Map ? result.scores : new Map();
    const inPool = (result.ranked || []).some(p => p.id === playerId) || scores.has(playerId);
    if (!inPool) return null;

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const ranks = competitionRanks(sorted.map(e => e[1]));
    const total = sorted.length;
    const index = sorted.findIndex(e => e[0] === playerId);

    if (index === -1) {
        return {
            seasonId, rank: null, total, tied: false,
            games: Number.isFinite(games) ? games : 0, percentiles: {}
        };
    }
    const rank = ranks[index];
    const pcts = result.byCategory instanceof Map ? result.byCategory.get(playerId) : null;
    const percentiles = {};
    if (pcts) pcts.forEach((v, id) => { percentiles[id] = v; });
    return {
        seasonId,
        rank,
        total,
        tied: ranks.filter(r => r === rank).length > 1,
        games: Number.isFinite(games) ? games : 0,
        percentiles
    };
}

// Several seasons for one player, ascending, with the seasons carrying no data LEFT OUT. `seasons` is [{ seasonId, result, games }], one per season already ranked. Sorting here rather than trusting the caller is deliberate: the contract promises ascending order so a trend reads left to right without the band having to sort, and a promise nothing enforces is a bug waiting.
export function seasonRowsFor(playerId, seasons) {
    return (seasons || [])
        .map(s => seasonRowFrom(s && s.result, playerId, { seasonId: s && s.seasonId, games: s && s.games }))
        .filter(Boolean)
        .sort((a, b) => a.seasonId - b.seasonId);
}
