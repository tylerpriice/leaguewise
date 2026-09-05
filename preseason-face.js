// PURE. The data behind the PRE-DRAFT face: what a league can honestly say about itself before anyone has picked. No DOM, no AppState, no fetches - every table it needs arrives as an argument, the same rule rank-engine.js and seasons-band.js follow. The face's hardest requirement is not a calculation, it is a refusal: a league in its first season has no last season, and the card must be ABSENT rather than filled with zeros. Every function here returns null for "nothing to say" and never a hollow shape.

import { draftSchedule } from './season-state.js';

// The countdown card. Reads the league's own draftSettings through draftSchedule (which takes the clock as an argument, so this does too) and turns it into the words the card prints. The unscheduled state is a real one, not an error: a league can exist for weeks before anyone picks a time, and ESPN sends 0 for it. It reads "Draft not scheduled" rather than a date in 1970 or a countdown to nothing.
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

// "Drafts today" / "Drafts tomorrow" / "Drafts in 6 days", and the past tense once the date has gone by. A draft date in the past with the draft still unheld is a real state - leagues postpone without moving the date - so it says so plainly instead of counting to a negative.
export function countdownPhrase(daysUntil) {
    if (daysUntil === null || daysUntil === undefined) return 'Draft not scheduled';
    if (daysUntil === 0) return 'Drafts today';
    if (daysUntil === 1) return 'Drafts tomorrow';
    if (daysUntil > 1) return `Drafts in ${daysUntil} days`;
    if (daysUntil === -1) return 'Draft date was yesterday';
    return `Draft date passed ${Math.abs(daysUntil)} days ago`;
}

// One team's rank in every category of a finished season, from the season payload's own valuesByStat - the same field the heatmap reads and the same field season-state.js uses to know a league has played. `inverseIds` arrives as an argument because INVERSE_STATS lives in state.js and importing it here would make this module impure. Getting it wrong is not cosmetic: in an inverse category like ERA the LOWEST value is first, and a module that ranked it the other way would name a manager's worst category as the best one.
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
            // Competition ranking: equal values share a place, so two teams tied on home runs are both second and nobody is told they were third by a hair they did not lose by.
            const rank = (i > 0 && scored[i - 1].v === r.v) ? out.get(scored[i - 1].id)[id] : i + 1;
            if (!out.has(r.id)) out.set(r.id, {});
            out.get(r.id)[id] = rank;
        });
    });
    return { ranks: out, of: teams.length };
}

// The last-season card, or NULL when there is nothing honest to show. Null is returned for a first season, for a season the payload could not describe, and for one whose franchises this league cannot be found in - three different reasons, one honest answer. The spec's word is "never faked", and the way a card gets faked is by defaulting: a champion of "Unknown", a finish of 0, a best category picked from an empty list.
export function lastSeasonCard(summary, payload, franchiseKey, opts = {}) {
    if (!summary || !summary.franchises || !summary.franchises.length) return null;
    // A season nobody finished cannot crown anyone. The history view already refuses to call these seasons decided, and this card is a smaller version of the same claim.
    if (summary.finished === false) return null;

    const champion = summary.championKey
        ? summary.franchises.find(f => f.key === summary.championKey) || null
        : null;
    const you = franchiseKey ? summary.franchises.find(f => f.key === franchiseKey) || null : null;

    // EVERY TEAM OF LAST SEASON, ORDERED BY PLACE. The card used to be three figures in a large empty box; this is what fills it. ORDERED BY PLACE, WITH THE CHAMPION MARKED RATHER THAN MOVED. The ruling asked for "the champion first", and measured on four finished seasons across three sports the champion IS finalRank 1 every time - including both head-to-head seasons, where the two could in principle differ because the champion is the bracket winner while the rank is a standing. So a champion-first reorder would be code that fires on no data we hold, until the day it fires on a season nobody checked and jumps a team above rank 1 in a table headed by place. Place wins; isChampion is how the row is told apart. A NULL PLACE SORTS TO THE BACK rather than to the front - a season that never ranked a team is not asserting that team finished first.
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
        // CARRIED RAW, as summarizeSeason carries it: whether a logo is loadable is a privacy question and images.js owns the host rule, so the renderer applies it, not this module.
        logo: f.logo,
        place: f.finalRank,
        // Null in roto, which keeps no W-L-T. summarizeSeason already made that choice and this passes it through rather than deciding it a second time.
        record: (f.wins === null) ? null : { wins: f.wins, losses: f.losses, ties: f.ties },
        // Null unless the format keeps points - points leagues and roto. See summarizeSeason.
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
            // A roto season keeps no W-L-T, so this is null rather than a fabricated 0-0-0 - the same choice summarizeSeason already made upstream.
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
                // One category cannot be both, so a league with a single ranked category reports a best and no worst rather than the same row twice under two headings.
                card.worst = worstId === bestId ? null : { id: worstId, label: label(worstId), rank: worstRank, of: summary.franchises.length };
            }
        }
    }

    // A card with no champion, no finish and no categories is an empty box wearing a heading.
    if (!card.champion && !card.finish) return null;
    return card;
}

// THE POOL, RANKED FOR THIS LEAGUE: the top of the projected board with the depth notes that bite. It takes ROWS AND DEPTH ALREADY COMPUTED rather than computing either, and that is the whole point of the shape. The board's rows come from the existing draft machinery and the depth from positionDepth in draft-engine.js - the same arithmetic the Draft tab's own card prints, which is what stops this card and that one disagreeing about whether goalies are short. Nothing here is a second opinion about a player's value. `clubs` is the pro-club abbreviation map, and a club it cannot name is NULL rather than a guess - the same rule the leaderboard's identity line follows.
export function rankedPoolCard(rows, depth, opts = {}) {
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 10;
    const clubs = opts.clubs || null;
    const top = (rows || [])
        .filter(r => r && r.boardRank)
        .slice(0, limit)
        .map(r => {
            const p = r.player || {};
            return {
                rank: r.boardRank,
                id: p.id,
                name: p.name,
                club: (clubs && p.proTeamId != null) ? (clubs.get(Number(p.proTeamId)) || null) : null,
                pos: p.positionDisplay || null,
                // The gold figure. Null when the projections could not value the pick, which is a real state on a board - it is left null rather than shown as a zero, because zero is a value and "no projection" is not.
                value: (r.value === null || r.value === undefined) ? null : r.value
            };
        });
    if (!top.length) return null;

    // Only the positions where depth actually bites. "deep" and the unworded middle say nothing a manager acts on before a draft, and a note against every position would be a wall of text that buries the two that matter. positionDepth already sorts tightest first.
    const notes = (depth || [])
        .filter(d => d && (d.word === 'cliff' || d.word === 'short'))
        .map(d => ({
            pos: d.pos,
            word: d.word,
            // "after #6" is the last player worth starting at the position, which is what the count of players above replacement means. It is the number a manager reaches by.
            after: d.available,
            // ZERO IS NOT AN ORDINAL. Measured on the real baseball board, RP came back with none above replacement, and the ordinal phrasing rendered "RP cliff after #0" - which reads as a cliff after the zeroth player rather than as the fact, which is that nobody at the position is worth starting at all.
            text: d.available > 0
                ? `${d.pos} ${d.word} after #${d.available}`
                : `${d.pos} ${d.word}, none above replacement`
        }));

    return { rows: top, notes };
}

// THE PRE-DRAFT LINEUP GROUND'S SEATS, in the shape lineup-ground.js's frozen contract asks for: [{ slotCode, count, playerName }]. Before a draft nobody is drafted, so every entry is anonymous by construction and a family with count > 1 IS the pre-draft case - the ground needs no separate signal for it. The codes are the league's OWN, through the validated catalog: labels[slot] is exactly what LINEUP_SLOT_LABELS produces, which is the vocabulary the ground already draws. A slot the catalog cannot name keeps its raw id as its code rather than being dropped or guessed onto the ground - the contract renders an unknown code in the dashed aside seat, which says "not claimed onto the field" honestly, and a seat the league opens is never hidden just because this app has no name for it. `order` is the sport's LINEUP_SLOT_ORDER when it has one, so the seats read the way a lineup card does rather than in numeric-id order; slots outside it follow, by id, so a league with a slot the order forgot still shows it.
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

// THE DRAFT, GRADED - the card's model, with no DOM anywhere near it. Two questions, kept separate because they fail separately: which categories the draft left a team strongest and weakest in, and which pick beat its own draft position by most. A league can answer the first and not the second - the picks arrive from a different ESPN view entirely - so a card built on one function that returned both would have had to invent half an answer.

// Every scored category this team has a projected figure in, ranked against the rest of the league, best first. Same competition ranking the heatmap shades by (ties share a place), and inverse-aware through an argument rather than an import, so a lower ERA ranks first. `valuesByTeam` is { teamId: { statId: value } } - the projected values, not component sums, since a rate cannot be compared until it has been recomputed. A category fewer than two teams have a figure in ranks NOBODY: with one team it is a rank of one out of one, which reads as a strength and is really an absence. That is not hypothetical - ESPN projects no fielding at all, so a league scoring errors has categories in exactly this shape.
export function projectedCategoryRanks(valuesByTeam, teamId, categoryIds, inverseIds) {
    const rows = Object.entries(valuesByTeam || {});
    const mine = (valuesByTeam || {})[teamId] || {};
    // NULL IS NOT ZERO, and Number(null) is 0 - which is why this reads the raw value before converting. A category the projections cannot speak to arrives as null for EVERY team, and converting first made them all zero, all tied, and all ranked #1: a real capture reported fielding assists as the team's STRONGEST category when no team has a projected figure in it at all. The same trap the heatmap's ranker had to be guarded against.
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
        // TIES KEEP THE LEAGUE'S OWN ORDER. Array.prototype.sort is stable, so equally-ranked categories come out in the order categoryIds listed them, which is the order the league lists its own scoring items. Breaking the tie on the stat id instead would name whichever category ESPN happens to number lower - it swapped a real card's weakest from SB to SV, both #4, for no reason a reader could see.
        .sort((a, b) => a.rank - b.rank);
}

// The pick that came in furthest ahead of where the board ranks the player, or NULL. Null covers three different failures on purpose - no picks, no board, and nobody who beat their own position - because all three mean the card has nothing to praise, and a zero-edge "best pick" would praise a pick that was exactly what it should have been. The caller says which it was; this only says there is no answer. `boardRanks` is a Map of playerId -> the board's own rank. A pick whose player the board does not rank is skipped rather than treated as ranked last: unranked is not 3000th.
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
