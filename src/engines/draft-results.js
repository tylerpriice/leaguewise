/**
 * The draft results board for a league whose draft is over: a grid with rounds down and teams
 * across, the reader's own team first. Also what the board is fed when ESPN has not yet published
 * the picks: the pick log placed on ESPN's own grid, or failing that the rosters.
 *
 * No player is resolved here. A cell carries a player id, and the caller's pool decides what to
 * print for it.
 *
 * Pure. No DOM, no application state, no network and no knowledge of any sport.
 *
 * Contract: tests/fixtures/draft-results.md
 * Tests: tests/draft-results.test.html
 * @module draft-results
 */
/**
 * The results board.
 *
 * @typedef {object} ResultsBoard
 * @property {string[]} teamOrder The team ids across the board, the reader's own first.
 * @property {?string} myTeamId The reader's team.
 * @property {Array<{round: number, cells: Array<?{playerId: *, teamId: *, round: number, roundPick: ?number, overall: ?number, keeper: boolean}>}>} rounds One row per round, with a cell per team in the board's order, or null where that team made no pick in the round.
 */

// Null is not zero, and Number(null) is 0, so an absent figure is tested for before it is converted.
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Builds the results board from the draft's picks. The drafted flag has no default: it is the
 * league's own, and without it ESPN's empty grid before a draft would read as results.
 *
 * @param {Array<{playerId: number, teamId: *, roundId: number, roundPickNumber: number, overallPickNumber: number, keeper: boolean}>} picks The draft's picks.
 * @param {object} [options]
 * @param {boolean} options.drafted The league's own flag that its draft is complete.
 * @param {Array} [options.teamIds] The league's full list of teams.
 * @param {?(number|string)} [options.myTeamId] The reader's team.
 * @returns {?ResultsBoard} The board, or null unless the league is drafted and at least one pick is filled. A pick with no round is left out.
 */
export function draftResultsBoard(picks, { drafted, teamIds = [], myTeamId = null } = {}) {
    if (drafted !== true || !Array.isArray(picks) || !picks.length) return null;

    // A pick ESPN has not filled carries a player id of exactly -1. A negative id is not the same thing: a football team defence has one and is a real pick.
    const real = picks.filter(p => p && Number.isFinite(Number(p.playerId)) && Number(p.playerId) !== -1);
    if (!real.length) return null;

    // The teams are in the order their first picks appear, never the payload's own team order. The league's full list then adds any team with no pick, so its column still exists.
    const seen = [];
    const seenSet = new Set();
    real.forEach(p => {
        const id = String(p.teamId);
        if (!seenSet.has(id)) { seenSet.add(id); seen.push(id); }
    });
    (teamIds || []).forEach(id => {
        const key = String(id);
        if (!seenSet.has(key)) { seenSet.add(key); seen.push(key); }
    });
    const mine = myTeamId === null || myTeamId === undefined ? null : String(myTeamId);
    const teamOrder = mine !== null && seenSet.has(mine)
        ? [mine, ...seen.filter(id => id !== mine)]
        : seen;

    // One cell per round and team. Where a payload carries the same pair twice, the earliest pick by overall number is kept.
    const byKey = new Map();
    let maxRound = 0;
    real.forEach(p => {
        const round = Number(p.roundId) || 0;
        if (!round) return; // no round to place it in - dropped, never guessed
        maxRound = Math.max(maxRound, round);
        const key = `${round}:${String(p.teamId)}`;
        const row = {
            playerId: p.playerId,
            teamId: p.teamId,
            round,
            roundPick: num(p.roundPickNumber),
            overall: num(p.overallPickNumber),
            keeper: p.keeper === true
        };
        const held = byKey.get(key);
        if (held && held.overall !== null && row.overall !== null && held.overall <= row.overall) return;
        byKey.set(key, row);
    });

    const rounds = [];
    for (let r = 1; r <= maxRound; r++) {
        rounds.push({ round: r, cells: teamOrder.map(teamId => byKey.get(`${r}:${teamId}`) || null) });
    }
    return { teamOrder, myTeamId: mine, rounds };
}

// ==== What feeds the results board ====

// ESPN does not set its drafted flag the moment a draft ends. What the board is fed in that window depends on what is known: ESPN's own picks carry the player and the slot, the pick log carries the player and its place in the run, and the rosters carry who is on which team and nothing about order.
const gridTeamId = (t) => (t && (t.id !== undefined && t.id !== null ? t.id : t.teamId));
const rosterEntriesOf = (t) => {
    if (!t) return [];
    const nested = t.roster && Array.isArray(t.roster.entries) ? t.roster.entries : null;
    if (nested) return nested;
    return Array.isArray(t.entries) ? t.entries : [];
};

// ESPN publishes the order of the whole draft even when the players are not in it. The grid is used only when it is whole: every overall from 1 to the count present, each with a round and a team.
function draftGridOf(picks) {
    const slots = new Map();
    (picks || []).forEach(p => {
        const overall = num(p && p.overallPickNumber);
        if (overall === null || overall < 1) return;
        if (slots.has(overall)) return;                 // a doubled payload: the first row wins, as the board's own rule does
        const round = num(p && p.roundId);
        const teamId = p && p.teamId !== undefined && p.teamId !== null ? p.teamId : null;
        slots.set(overall, { round, roundPick: num(p && p.roundPickNumber), teamId });
    });
    const count = slots.size;
    if (!count) return null;
    let rounds = 0;
    const teamIds = new Set();
    for (let overall = 1; overall <= count; overall++) {
        const slot = slots.get(overall);
        if (!slot || slot.round === null || slot.round < 1 || slot.teamId === null) return null;
        rounds = Math.max(rounds, slot.round);
        teamIds.add(String(slot.teamId));
    }
    return { count, rounds, teams: teamIds.size, slots };
}

// Complete means every overall from 1 to the grid's count, once. The count alone is not enough, since a log with a gap has the right length and puts every later pick in the wrong round.
function logCoversGrid(log, count) {
    const picks = log && Array.isArray(log.picks) ? log.picks : null;
    if (!picks || picks.length !== count) return null;
    const byOverall = new Map();
    for (const pick of picks) {
        const overall = num(pick && pick.overall);
        if (overall === null || overall < 1 || overall > count) return null;
        if (byOverall.has(overall)) return null;
        const playerId = pick.playerId;
        // The placeholder is never read as a filled pick.
        if (playerId === null || playerId === undefined || Number(playerId) === -1) return null;
        byOverall.set(overall, pick);
    }
    return byOverall.size === count ? byOverall : null;
}

/**
 * Decides what the results board is fed, by how much each source knows: ESPN's own picks, then
 * the pick log when it covers the whole grid, then the rosters. The answer says which was used
 * and whether the order of the picks is known.
 *
 * @param {object} [args]
 * @param {{drafted: boolean, picks: object[]}} args.draftDetail The league's draft detail.
 * @param {{picks: object[]}} [args.log] The pick log.
 * @param {object[]} [args.rosters] Each team with its roster entries.
 * @param {object[]} [args.teams] The league's teams. Defaults to the rosters' teams.
 * @param {?(number|string)} [args.myTeamId] The reader's team.
 * @returns {{basis: ('espn'|'log'|'rosters'|'none'), orderKnown: boolean, grid: ?{count: number, rounds: number, teams: number}, board: ?ResultsBoard, teams: ?Array<{teamId: *, mine: boolean, players: object[]}>, teamMismatches: Array<{overall: number, logged: *, grid: *}>}}
 *   A board for the first two bases, and for the rosters basis each team's players with no order.
 */
export function resultsFeedFor({ draftDetail, log, rosters, teams, myTeamId = null } = {}) {
    const picks = draftDetail && Array.isArray(draftDetail.picks) ? draftDetail.picks : [];
    const rosterTeams = Array.isArray(rosters) ? rosters : [];
    const teamList = Array.isArray(teams) && teams.length ? teams : rosterTeams;
    const teamIds = teamList.map(gridTeamId).filter(id => id !== null && id !== undefined);
    const grid = draftGridOf(picks);
    const gridOut = grid ? { count: grid.count, rounds: grid.rounds, teams: grid.teams } : null;
    const answer = (basis, board = null, teamsOut = null, mismatches = []) =>
        ({ basis, orderKnown: basis === 'espn' || basis === 'log', grid: gridOut, board, teams: teamsOut, teamMismatches: mismatches });

    // 1. ESPN's own picks, through draftResultsBoard and nothing else, with the drafted flag passed exactly as the payload gives it.
    const espnBoard = draftResultsBoard(picks, { drafted: draftDetail && draftDetail.drafted, teamIds, myTeamId });
    if (espnBoard) return answer('espn', espnBoard);

    // 2. The pick log, placed on ESPN's own grid. The log supplies the player; the round, the pick within it and the team come from the grid's slot at that overall. Where the log's team differs from the grid's, the difference is reported and the grid's team is used.
    if (grid) {
        const byOverall = logCoversGrid(log, grid.count);
        if (byOverall) {
            const rows = [];
            const teamMismatches = [];
            for (let overall = 1; overall <= grid.count; overall++) {
                const slot = grid.slots.get(overall);
                const pick = byOverall.get(overall);
                const logged = pick.teamId === null || pick.teamId === undefined ? null : pick.teamId;
                if (logged !== null && String(logged) !== String(slot.teamId)) {
                    teamMismatches.push({ overall, logged, grid: slot.teamId });
                }
                rows.push({
                    playerId: pick.playerId,
                    teamId: slot.teamId,
                    roundId: slot.round,
                    roundPickNumber: slot.roundPick,
                    overallPickNumber: overall,
                    keeper: false               // the log has no keeper flag to carry; never invented
                });
            }
            const board = draftResultsBoard(rows, { drafted: true, teamIds, myTeamId });
            if (board) return answer('log', board, null, teamMismatches);
        }
    }

    // 3. The rosters, which say who and not when. Every team must hold somebody, since one empty team means this is not a finished draft.
    if (rosterTeams.length) {
        const out = [];
        for (const team of rosterTeams) {
            const teamId = gridTeamId(team);
            if (teamId === null || teamId === undefined) return answer('none');
            const players = [];
            const seen = new Set();
            rosterEntriesOf(team).forEach(entry => {
                if (!entry) return;
                const playerId = entry.playerId !== undefined && entry.playerId !== null
                    ? entry.playerId
                    : (entry.playerPoolEntry && entry.playerPoolEntry.id);
                if (playerId === null || playerId === undefined || Number(playerId) === -1) return;
                const key = String(playerId);
                if (seen.has(key)) return;
                seen.add(key);
                players.push({ playerId, lineupSlotId: num(entry.lineupSlotId) });
            });
            if (!players.length) return answer('none');
            out.push({ teamId, mine: false, players });
        }
        const mine = myTeamId === null || myTeamId === undefined ? null : String(myTeamId);
        out.forEach(row => { row.mine = mine !== null && String(row.teamId) === mine; });
        // The reader's own team leads. There is no pick order to keep here, so the other teams stay in the payload's order.
        const ordered = mine === null ? out : [...out.filter(r => r.mine), ...out.filter(r => !r.mine)];
        return answer('rosters', null, ordered);
    }

    return answer('none');
}
