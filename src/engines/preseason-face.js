/**
 * What a league can say about itself around its draft: the countdown, last season's card, the
 * ranked pool, the lineup's seats, and the draft read back pick by pick.
 *
 * Pure. No DOM, no application state and no network; every table arrives as an argument. A league
 * in its first season has no last season, so every function returns null when there is nothing to
 * say and never a shape filled with zeros.
 *
 * Tests: tests/preseason-face.test.html
 * @module preseason-face
 */
/**
 * One draft pick, as ESPN's draft detail carries it.
 *
 * @typedef {object} DraftPick
 * @property {number} playerId The player. ESPN files -1 for a pick not yet made.
 * @property {number} teamId The team that owns the pick.
 * @property {number} [roundId] The round.
 * @property {number} [roundPickNumber] The pick within the round.
 * @property {number} [overallPickNumber] The overall pick.
 * @property {boolean} [keeper] Whether the pick is a keeper.
 */

import { draftSchedule } from '../data/season-state.js';

/**
 * The countdown to the draft, in the words a card prints. A league with no draft time set reads
 * 'Draft not scheduled'.
 *
 * @param {object} payload The league payload.
 * @param {Date} now The present.
 * @param {?number} [teamId] The reader's team, for its draft slot.
 * @returns {{scheduled: boolean, phrase: string, date: ?Date, daysUntil: (number|undefined), type: *, slot: *, teams: *}} The card.
 */
export function countdownCard(payload, now, teamId = null) {
    const s = draftSchedule(payload, now, teamId);
    if (!s.hasDate) {
        return { scheduled: false, phrase: 'Draft not scheduled', date: null, type: s.type, slot: s.slot, teams: s.teams };
    }
    return {
        scheduled: true,
        phrase: countdownPhrase(s.daysUntil),
        date: s.date,
        daysUntil: s.daysUntil,
        type: s.type,
        slot: s.slot,
        teams: s.teams
    };
}

/**
 * The countdown as a phrase: today, tomorrow, in so many days, or how long ago the date passed.
 * A draft date in the past with the draft unheld is a real state and is said plainly.
 *
 * @param {?number} daysUntil Days until the draft; negative once the date has passed.
 * @returns {string} The phrase.
 */
export function countdownPhrase(daysUntil) {
    if (daysUntil === null || daysUntil === undefined) return 'Draft not scheduled';
    if (daysUntil === 0) return 'Drafts today';
    if (daysUntil === 1) return 'Drafts tomorrow';
    if (daysUntil > 1) return `Drafts in ${daysUntil} days`;
    if (daysUntil === -1) return 'Draft date was yesterday';
    return `Draft date passed ${Math.abs(daysUntil)} days ago`;
}

/**
 * Each team's rank in every category of a finished season, from the season payload's own team
 * totals. A category fewer than two teams posted ranks nobody.
 *
 * @param {object} payload The season's league payload.
 * @param {string[]} statIds The scored categories.
 * @param {Set<string>} inverseIds The categories where lower is better, passed in so the lowest value ranks first there.
 * @returns {{ranks: Map<number, Object<string, number>>, of: number}} Each team's rank by category, and the number of teams.
 */
export function categoryRanks(payload, statIds, inverseIds) {
    const teams = (payload && payload.teams) || [];
    const out = new Map();
    (statIds || []).forEach(id => {
        const scored = teams
            .map(t => ({ id: t.id, v: Number((t.valuesByStat || {})[id]) }))
            .filter(r => Number.isFinite(r.v));
        if (scored.length < 2) return;   // a category one team posted ranks nobody
        const inverse = inverseIds && inverseIds.has(id);
        scored.sort((a, b) => inverse ? a.v - b.v : b.v - a.v);
        scored.forEach((r, i) => {
            // Competition ranking: equal values share a place.
            const rank = (i > 0 && scored[i - 1].v === r.v) ? out.get(scored[i - 1].id)[id] : i + 1;
            if (!out.has(r.id)) out.set(r.id, {});
            out.get(r.id)[id] = rank;
        });
    });
    return { ranks: out, of: teams.length };
}

/**
 * The last-season card: the champion, every team in order of place, and the reader's own finish
 * with its best and worst category.
 *
 * @param {object} summary The season, as history.js's summarizeSeason reduces it.
 * @param {object} payload The season's league payload.
 * @param {?string} franchiseKey The reader's franchise.
 * @param {object} [opts]
 * @param {Set<string>} [opts.inverseIds] The categories where lower is better.
 * @param {Object<string, string>} [opts.statMap] Labels by stat id.
 * @returns {?{year: number, format: string, champion: ?object, standings: object[], finish: ?object, best: ?object, worst: ?object}}
 *   Null for a first season, an unfinished one, and one with neither a champion nor the reader's
 *   franchise in it.
 */
export function lastSeasonCard(summary, payload, franchiseKey, opts = {}) {
    if (!summary || !summary.franchises || !summary.franchises.length) return null;
    // A season nobody finished cannot crown anyone.
    if (summary.finished === false) return null;

    const champion = summary.championKey
        ? summary.franchises.find(f => f.key === summary.championKey) || null
        : null;
    const you = franchiseKey ? summary.franchises.find(f => f.key === franchiseKey) || null : null;

    // Every team of last season, ordered by place, with the champion marked and not moved. A team with no place sorts to the back, since a season that never ranked a team is not saying it finished first.
    const ordered = (summary.franchises || []).slice().sort((a, b) => {
        if (a.finalRank === b.finalRank) return 0;
        if (a.finalRank === null || a.finalRank === undefined) return 1;
        if (b.finalRank === null || b.finalRank === undefined) return -1;
        return a.finalRank - b.finalRank;
    });
    const standings = ordered.map(f => ({
        key: f.key,
        teamId: f.teamId,
        name: f.name,
        abbrev: f.abbrev,
        // Carried as filed. Whether a logo may be loaded is for whoever renders it; images.js owns that rule.
        logo: f.logo,
        place: f.finalRank,
        // Null in roto, which keeps no record.
        record: (f.wins === null) ? null : { wins: f.wins, losses: f.losses, ties: f.ties },
        // Null unless the format keeps points, which a points league and a roto league do.
        points: f.points ?? null,
        isYou: !!(you && f.key === you.key),
        isChampion: !!(champion && f.key === champion.key)
    }));

    const card = {
        year: summary.year,
        format: summary.format,
        champion: champion ? { name: champion.name, abbrev: champion.abbrev, isYou: !!(you && champion.key === you.key) } : null,
        standings,
        finish: null,
        best: null,
        worst: null
    };

    if (you) {
        card.finish = {
            rank: you.finalRank,
            of: summary.franchises.length,
            // A roto season keeps no record, so this is null and not 0-0-0.
            record: (you.wins === null) ? null : { wins: you.wins, losses: you.losses, ties: you.ties }
        };
        const { ranks } = categoryRanks(payload, summary.statIds, opts.inverseIds || new Set());
        const mine = you.teamId != null ? ranks.get(you.teamId) : null;
        if (mine) {
            const entries = Object.entries(mine);
            if (entries.length) {
                const sorted = [...entries].sort((a, b) => a[1] - b[1]);
                const label = (id) => (opts.statMap && opts.statMap[id]) || id;
                const [bestId, bestRank] = sorted[0];
                const [worstId, worstRank] = sorted[sorted.length - 1];
                card.best = { id: bestId, label: label(bestId), rank: bestRank, of: summary.franchises.length };
                // One category cannot be both, so a league with a single ranked category reports a best and no worst.
                card.worst = worstId === bestId ? null : { id: worstId, label: label(worstId), rank: worstRank, of: summary.franchises.length };
            }
        }
    }

    // A card with no champion and no finish has nothing to show.
    if (!card.champion && !card.finish) return null;
    return card;
}

/**
 * The top of the projected pool for this league, with a note for each position where depth runs
 * short. The rows and the depth arrive already computed, so this card and the Draft tab cannot
 * disagree. The figure shown is the player's projected points under the league's own scoring.
 *
 * @param {Array<{player: object, boardRank: number, score: number}>} rows The board's rows.
 * @param {Array<{pos: string, word: string, available: number}>} depth The depth per position, from draft-engine.js.
 * @param {object} [opts]
 * @param {number} [opts.limit=10] How many players to list.
 * @param {Map<number, string>} [opts.clubs] Club abbreviations by pro team id.
 * @returns {?{rows: Array<{rank: number, id: *, name: string, club: ?string, pos: ?string, value: ?number}>, notes: Array<{pos: string, word: string, after: number, text: string}>}}
 *   Null when no row is ranked.
 */
export function rankedPoolCard(rows, depth, opts = {}) {
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 10;
    const clubs = opts.clubs || null;
    // Ranked by points and not by the incoming board order. The rank is this list's own position, from one.
    const pointsOf = (r) => Number.isFinite(r && r.score) ? r.score : -Infinity;
    const ranked = (rows || [])
        .filter(r => r && r.boardRank)
        .slice()
        .sort((a, b) => pointsOf(b) - pointsOf(a));
    const top = ranked.slice(0, limit).map((r, i) => {
        const p = r.player || {};
        return {
            rank: i + 1,
            id: p.id,
            name: p.name,
            club: (clubs && p.proTeamId != null) ? (clubs.get(Number(p.proTeamId)) || null) : null,
            pos: p.positionDisplay || null,
            // Null when the projections could not value the player. Zero is a value, and no projection is not.
            value: Number.isFinite(r.score) ? r.score : null
        };
    });
    if (!top.length) return null;

    // Only the positions where depth bites. A note against every position would bury the two that matter.
    const notes = (depth || [])
        .filter(d => d && (d.word === 'cliff' || d.word === 'short'))
        .map(d => ({
            pos: d.pos,
            word: d.word,
            // The count of players above replacement at the position, which is the last player worth starting there.
            after: d.available,
            // Zero is not an ordinal. With nobody above replacement, the note says so and does not point after a player numbered zero.
            text: d.available > 0
                ? `${d.pos} ${d.word} after #${d.available}`
                : `${d.pos} ${d.word}, none above replacement`
        }));

    return { rows: top, notes };
}

/**
 * The lineup's seats before a draft, in the shape lineup-ground.js draws: one entry per slot the
 * league fields, with its count and no player. A slot with no label keeps its id as its code.
 *
 * @param {object} [args]
 * @param {Object<number, number>} [args.counts] How many of each slot the league fields.
 * @param {Object<number, string>} [args.labels] The slot labels.
 * @param {?number[]} [args.order] The order a lineup reads in. Slots outside it follow by id.
 * @returns {Array<{slotCode: string, count: number, playerName: null}>} The seats.
 */
export function slotSeatsFor({ counts = {}, labels = {}, order = null } = {}) {
    const ids = Object.keys(counts)
        .map(Number)
        .filter(id => Number.isFinite(id) && Number(counts[id]) > 0);
    const rank = (id) => {
        const at = order ? order.indexOf(id) : -1;
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    };
    ids.sort((a, b) => (rank(a) - rank(b)) || (a - b));
    return ids.map(id => ({
        slotCode: labels[id] || String(id),
        count: Number(counts[id]),
        playerName: null
    }));
}

// The draft, read back. Two questions are kept apart because they fail apart: which categories the draft left a team strongest and weakest in, and which pick beat its own draft position by most. The picks come from a different ESPN view, so a league can answer the first and not the second.

/**
 * Every scored category a team has a projected figure in, ranked against the rest of the league,
 * best first. Ties share a place. A category fewer than two teams have a figure in ranks nobody.
 *
 * @param {Object<string, Object<string, ?number>>} valuesByTeam Each team's projected values by stat id. Values, not component sums.
 * @param {number|string} teamId The team.
 * @param {Array<string|number>} categoryIds The scored categories, in the league's own order.
 * @param {Set<string>} inverseIds The categories where lower is better.
 * @returns {Array<{id: string, value: number, rank: number, of: number}>} The team's categories.
 */
export function projectedCategoryRanks(valuesByTeam, teamId, categoryIds, inverseIds) {
    const rows = Object.entries(valuesByTeam || {});
    const mine = (valuesByTeam || {})[teamId] || {};
    // Null is not zero, and Number(null) is 0, so the raw value is read before it is converted. A category no projection covers arrives as null for every team, and must not rank them all first.
    const figure = (row, id) => {
        const raw = (row || {})[id];
        if (raw === null || raw === undefined) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    };
    return (categoryIds || [])
        .map(id => {
            const v = figure(mine, id);
            if (v === null) return null;
            const vals = rows
                .map(([, r]) => figure(r, id))
                .filter(x => x !== null);
            if (vals.length < 2) return null;
            const inverse = !!(inverseIds && inverseIds.has(String(id)));
            const better = vals.filter(x => inverse ? x < v : x > v).length;
            return { id: String(id), value: v, rank: better + 1, of: vals.length };
        })
        .filter(Boolean)
        // Ties keep the league's own order. The sort is stable, so categories of equal rank come out in the order the league lists its scoring items.
        .sort((a, b) => a.rank - b.rank);
}

/**
 * The pick that came in furthest behind where the board ranks its player. A player the board does
 * not rank is skipped, not treated as ranked last.
 *
 * @param {DraftPick[]} picks The picks to choose among.
 * @param {Map<number, number>} boardRanks The board's rank by player id.
 * @returns {?{playerId: number, overallPickNumber: number, rank: number, edge: number}} Null with no picks, no board, or nobody taken later than the board's rank.
 */
export function bestValuePick(picks, boardRanks) {
    const ranks = boardRanks || new Map();
    const scored = (picks || [])
        .map(pick => ({ pick, rank: ranks.get(pick && pick.playerId) }))
        .filter(r => Number.isFinite(r.rank) && Number.isFinite(r.pick.overallPickNumber))
        .map(r => ({ playerId: r.pick.playerId, overallPickNumber: r.pick.overallPickNumber, rank: r.rank, edge: r.pick.overallPickNumber - r.rank }))
        .sort((a, b) => b.edge - a.edge || a.overallPickNumber - b.overallPickNumber);
    if (!scored.length || scored[0].edge <= 0) return null;
    return scored[0];
}

/**
 * One team's picks in draft order, each measured against the board, with the best value marked.
 * The marked row is the pick bestValuePick names over these same rows.
 *
 * @param {DraftPick[]} picks Every pick of the draft.
 * @param {Map<number, number>} boardRanks The board's rank by player id.
 * @param {?(number|string)} teamId The team. Null returns nothing.
 * @returns {Array<{round: ?number, overallPickNumber: number, playerId: number, rank: ?number, edge: ?number, best: boolean}>}
 *   The rows. A pick with no overall number is left out.
 */
export function draftPickRows(picks, boardRanks, teamId) {
    if (teamId === null || teamId === undefined) return [];
    const ranks = boardRanks || new Map();
    const want = String(teamId);
    const mine = (picks || []).filter(p =>
        p && String(p.teamId) === want && Number.isFinite(p.overallPickNumber));
    const best = bestValuePick(mine, ranks);
    return mine
        .slice()
        .sort((a, b) => a.overallPickNumber - b.overallPickNumber)
        .map(p => {
            const rank = ranks.get(p.playerId);
            const ranked = Number.isFinite(rank);
            return {
                round: p.roundId ?? null,
                overallPickNumber: p.overallPickNumber,
                playerId: p.playerId,
                rank: ranked ? rank : null,
                edge: ranked ? p.overallPickNumber - rank : null,
                // Matched on the pick and not only the player, so a list carrying one player twice cannot mark two rows.
                best: !!best && best.playerId === p.playerId
                    && best.overallPickNumber === p.overallPickNumber
            };
        });
}

/**
 * Where every drafted player went, as one lookup built in a single pass over the picks.
 *
 * The drafted flag has no default. It is the league's own, and without it ESPN's empty grid of
 * picks before a draft would read as a finished one.
 *
 * The sort key is the overall pick number. A pick with a round and no overall number takes the
 * round times a thousand, so it sorts after every numbered pick, and a pick with neither sorts last.
 *
 * @param {DraftPick[]} picks Every pick of the draft.
 * @param {object} [options]
 * @param {?(number|string)} [options.myTeamId] The team the reader is looking through.
 * @param {boolean} options.drafted The league's own flag that its draft is complete.
 * @returns {Map<string, {pick: ?number, round: ?number, roundPick: ?number, teamId: *, mine: boolean, keeper: boolean, label: string, sortKey: number}>}
 *   A cell by player id as a string. Empty unless drafted is true.
 */
export function draftedIndexOf(picks, { myTeamId = null, drafted } = {}) {
    if (drafted !== true) return new Map();
    const mine = myTeamId === null || myTeamId === undefined ? null : String(myTeamId);
    const index = new Map();
    (picks || []).forEach(p => {
        if (!p) return;
        const id = Number(p.playerId);
        // ESPN's placeholder for a pick not yet made is exactly -1. A football team defence has a negative id of its own and is a real pick.
        if (!Number.isFinite(id) || id === -1) return;
        const key = String(p.playerId);
        const overall = Number.isFinite(Number(p.overallPickNumber)) ? Number(p.overallPickNumber) : null;
        const held = index.get(key);
        // The earliest pick wins, the rule draftPickOf follows.
        if (held && held.pick !== null && overall !== null && held.pick <= overall) return;
        const round = p.roundId ?? null;
        index.set(key, {
            pick: overall,
            round,
            roundPick: Number.isFinite(Number(p.roundPickNumber)) ? Number(p.roundPickNumber) : null,
            teamId: p.teamId ?? null,
            mine: mine !== null && p.teamId !== null && p.teamId !== undefined && String(p.teamId) === mine,
            keeper: p.keeper === true,
            label: round !== null && overall !== null ? `${round}.${overall}`
                : round !== null ? `R${round}`
                : 'Drafted',
            sortKey: overall !== null ? overall : (round !== null ? round * 1000 : Infinity)
        });
    });
    return index;
}

/**
 * Where one player was drafted. Null means undrafted, which is a real answer for the caller to
 * word. The team is an id and not a name.
 *
 * @param {DraftPick[]} picks Every pick of the draft.
 * @param {number|string} playerId The player. Ids are compared as strings.
 * @returns {?{round: ?number, overallPickNumber: ?number, teamId: *}} The earliest pick of the player, or null.
 */
export function draftPickOf(picks, playerId) {
    if (playerId === null || playerId === undefined) return null;
    const want = String(playerId);
    const mine = (picks || []).filter(p => p && String(p.playerId) === want);
    if (!mine.length) return null;
    // The earliest, so a list that carries a player twice answers the same way every time.
    const pick = mine.reduce((best, p) => {
        const a = Number(p.overallPickNumber), b = Number(best.overallPickNumber);
        if (!Number.isFinite(a)) return best;
        if (!Number.isFinite(b)) return p;
        return a < b ? p : best;
    }, mine[0]);
    return {
        round: pick.roundId ?? null,
        overallPickNumber: Number.isFinite(Number(pick.overallPickNumber))
            ? Number(pick.overallPickNumber) : null,
        teamId: pick.teamId ?? null
    };
}
