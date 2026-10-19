/**
 * How each pick has fared as the season goes on: the slot a player went at against the slot the
 * player is producing at, and whether the player is over or under the preseason line. One row per
 * pick and one summary per team.
 *
 * The value is handed in. The caller ranks the players once, the same way the Draft board does, so
 * the board and these rows cannot give two answers about one player.
 *
 * Pure, and it imports nothing. No DOM, no application state, no network, no stat ids and no
 * sport.
 *
 * Contract: tests/fixtures/draft-hindsight.md
 * Tests: tests/draft-hindsight.test.html
 * @module draft-hindsight
 */
/**
 * One pick, set against how the player has produced.
 *
 * @typedef {object} HindsightRow
 * @property {*} playerId The player.
 * @property {*} teamId The team that made the pick.
 * @property {?number} round The round.
 * @property {?number} roundPick The pick within the round.
 * @property {?number} overall The overall pick.
 * @property {boolean} keeper Whether the pick was a keeper. A keeper's slot is a league rule, so it is not graded.
 * @property {boolean} inPool Whether the caller's values carry the player.
 * @property {?number} value The player's value.
 * @property {?number} rank The rank the player is producing at.
 * @property {?number} total How many players are ranked.
 * @property {boolean} tied Whether the rank is shared.
 * @property {?number} games The player's games.
 * @property {?number} slotGap The overall pick less the rank. Positive means the player is producing above the slot.
 * @property {boolean} ungraded In the pool, not a keeper, and with no rank.
 * @property {?object} pace Over or under the preseason line, from the caller.
 */

const key = id => String(id);
// Null is not zero, and Number(null) is 0, so an absent figure stays absent.
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

// ESPN publishes a grid of picks before a draft, each at a player id of -1. Those are not picks. The test is exactly -1, since a football team defence has a negative id and is a real pick.
const PLACEHOLDER_ID = -1;

function lookUp(values, playerId) {
    if (!values) return null;
    if (values instanceof Map) return values.get(playerId) ?? values.get(key(playerId)) ?? null;
    return values[key(playerId)] ?? null;
}

/**
 * One row per pick, in pick order. Neither flag has a default: the draft must be complete and
 * games must have been played, by the league's own word, or there are no rows.
 *
 * @param {Array<{playerId: number, teamId: *, roundId: number, roundPickNumber: number, overallPickNumber: number, keeper: boolean}>} picks The draft's picks.
 * @param {object} [options]
 * @param {?(Map|Object<string, {value: number, rank: number, total: number, tied: boolean, games: number}>)} [options.values] Each player's value and rank, computed once by the caller.
 * @param {function(*): ?object} [options.pacingFor] A player's pace against the preseason line.
 * @param {boolean} options.drafted The league's own flag that its draft is complete.
 * @param {boolean} options.played Whether the league has played a game.
 * @returns {HindsightRow[]} The rows. A pick outside the pool keeps its id and is not graded.
 */
export function hindsightRows(picks, { values = null, pacingFor = null, drafted, played } = {}) {
    if (drafted !== true || played !== true || !Array.isArray(picks)) return [];

    const rows = picks
        .filter(p => p && Number(p.playerId) !== PLACEHOLDER_ID)
        .map(p => {
            const playerId = p.playerId;
            const found = lookUp(values, playerId);
            const inPool = !!found;
            const rank = inPool ? num(found.rank) : null;
            const overall = num(p.overallPickNumber);
            const keeper = p.keeper === true;
            return {
                playerId,
                teamId: p.teamId ?? null,
                round: num(p.roundId),
                roundPick: num(p.roundPickNumber),
                overall,
                keeper,
                inPool,
                value: inPool ? num(found.value) : null,
                rank,
                total: inPool ? num(found.total) : null,
                tied: inPool ? found.tied === true : false,
                games: inPool ? num(found.games) : null,
                // A keeper's slot is a league rule and not a judgement about the player, so it is marked and not graded. Its value and pace are still given.
                slotGap: (keeper || !inPool || rank === null || overall === null) ? null : overall - rank,
                // Ungraded is decided here, once: in the pool, not a keeper, and no rank. Why the rank is missing is the caller's to say.
                ungraded: inPool && !keeper && rank === null,
                pace: (pacingFor && pacingFor(playerId)) || null
            };
        });

    // A pick with no overall number sorts last, since a missing figure at the front would read as the first pick.
    return rows.sort((a, b) => {
        if (a.overall === null && b.overall === null) return 0;
        if (a.overall === null) return 1;
        if (b.overall === null) return -1;
        return a.overall - b.overall;
    });
}

/**
 * One summary per team: its picks, how many were graded, the slot gaps summed, its best and worst
 * pick by slot gap, and how many of its players are over, under and even against the preseason
 * line.
 *
 * @param {HindsightRow[]} rows The rows from hindsightRows.
 * @param {object} [options]
 * @param {Array<{id: *, name: string}>} [options.teams] The league's teams, for their names.
 * @returns {Array<{teamId: *, name: ?string, picks: number, graded: number, slotGapTotal: number, best: ?{playerId: *, slotGap: number}, worst: ?{playerId: *, slotGap: number}, over: number, under: number, even: number}>}
 *   The teams, in the order their first picks appear.
 */
export function teamHindsight(rows, { teams = [] } = {}) {
    const nameOf = new Map((teams || []).filter(Boolean).map(t => [key(t.id), t.name ?? null]));
    const order = [];
    const byTeam = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
        const k = key(row.teamId);
        if (!byTeam.has(k)) { byTeam.set(k, []); order.push({ k, teamId: row.teamId }); }
        byTeam.get(k).push(row);
    });

    return order.map(({ k, teamId }) => {
        const mine = byTeam.get(k);
        const graded = mine.filter(r => r.slotGap !== null);
        // A tie takes the earlier pick, so the same input always names the same two picks.
        const pickOf = (better) => graded.reduce((best, r) => {
            if (!best) return r;
            if (r.slotGap === best.slotGap) return (r.overall ?? Infinity) < (best.overall ?? Infinity) ? r : best;
            return better(r.slotGap, best.slotGap) ? r : best;
        }, null);
        const best = pickOf((a, b) => a > b);
        const worst = pickOf((a, b) => a < b);
        const dirs = mine.reduce((acc, r) => {
            const d = r.pace && r.pace.dir;
            if (d === 'over' || d === 'under' || d === 'even') acc[d] += 1;
            return acc;
        }, { over: 0, under: 0, even: 0 });
        return {
            teamId,
            name: nameOf.has(k) ? nameOf.get(k) : null,
            picks: mine.length,
            // How many picks the total covers, beside the total. It differs from the pick count by the keepers, the players not in the pool and the unranked.
            graded: graded.length,
            slotGapTotal: graded.reduce((sum, r) => sum + r.slotGap, 0),
            best: best ? { playerId: best.playerId, slotGap: best.slotGap } : null,
            worst: worst ? { playerId: worst.playerId, slotGap: worst.slotGap } : null,
            ...dirs
        };
    });
}
