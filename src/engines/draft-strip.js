/**
 * What the draft room's status strip and tray say: how much of a position is left in its tier,
 * who picks next and what they need, every pick as a grid, the seat group most at risk, the tag
 * for a pick against its average draft position, and an age in words.
 *
 * Each of these is a reading draft-engine.js already produces: tiers, the order, the verdict
 * against average draft position, the open seats. This module puts them into the shapes the strip
 * and the tray print and adds no arithmetic of its own.
 *
 * Pure. No DOM, no application state and no storage. The board, the order and the picks arrive as
 * arguments.
 *
 * Contract: tests/fixtures/draft-strip.md
 * Tests: tests/draft-strip.test.html
 * @module draft-strip
 */
/**
 * One turn in the draft order, as the strip prints it.
 *
 * @typedef {object} StripPick
 * @property {number} overall The overall pick, from one.
 * @property {number} round The round, from one.
 * @property {number} pickInRound The pick within the round, from one.
 * @property {number|string} teamId The team picking.
 * @property {boolean} isUser Whether the pick is the reader's.
 * @property {Array<{position: string, open: number}>} needs The seats that team still has open.
 */
import { tierBreaks, tierOf, adpVerdict } from './draft-engine.js';

const MIDDOT = String.fromCharCode(183);

// Two row shapes arrive here: a board row, with its player nested, and a flat row. Both are read through these.
const idOf = (row) => (row && row.player && row.player.id !== undefined ? row.player.id : row && row.id);
const positionsOf = (row) => (row && row.player && row.player.eligiblePositions)
    || (row && row.eligiblePositions) || [];
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

// ==== (a) The tier break: how much of a position is left in its tier ====

/**
 * How much of one position is left in the tier a player sits in: how many the tier held, how
 * many are taken, and how many remain.
 *
 * The tiers are cut over the position's own players, taken ones included, so the tier is the same
 * set on every call and the count of those already drafted has a total to be out of.
 *
 * @param {object[]} rows The pool as the draft found it, best first. It may be the whole board.
 * @param {Array<number|string>} takenIds The players already taken.
 * @param {string} position The position.
 * @param {object} [options]
 * @param {?(number|string)} [options.playerId] Pin the tier to this player's. Without it, the tier of the best player left at the position.
 * @param {number} [options.minGap] The drop in value that opens a new tier.
 * @param {number} [options.maxSize] The most players one tier holds.
 * @returns {?{position: string, tier: number, total: number, taken: number, left: number}} Null when the position has no players or none left.
 */
export function tierState(rows, takenIds, position, { playerId = null, minGap, maxSize } = {}) {
    const taken = new Set((takenIds || []).map(String));
    const mine = (rows || []).filter(row => positionsOf(row).indexOf(position) !== -1);
    if (!mine.length) return null;

    // The tier cut reads a value and nothing else. A row that carries its points as a score has it handed over under that name.
    const valued = mine.map(row => ({ value: Number.isFinite(row.value) ? row.value : Number(row.score) || 0 }));
    const cut = {};
    if (minGap !== undefined) cut.minGap = minGap;
    if (maxSize !== undefined) cut.maxSize = maxSize;
    const breaks = tierBreaks(valued, cut);

    let anchor = -1;
    if (playerId !== null && playerId !== undefined) anchor = mine.findIndex(r => sameId(idOf(r), playerId));
    if (anchor === -1) anchor = mine.findIndex(r => !taken.has(String(idOf(r))));
    // Nobody is left at the position, so there is no tier to speak of. Null, since a zero would read as a tier that happens to be empty.
    if (anchor === -1) return null;

    const tier = tierOf(anchor, breaks);
    let total = 0;
    let gone = 0;
    mine.forEach((row, i) => {
        if (tierOf(i, breaks) !== tier) return;
        total += 1;
        if (taken.has(String(idOf(row)))) gone += 1;
    });
    return { position, tier, total, taken: gone, left: total - gone };
}

// ==== (b) Next up: who picks after the pick on the clock, and what they still need ====

/**
 * The picks after the one on the clock, each with its team and the seats that team still has
 * open, and where the reader's next turn falls.
 *
 * @param {Array<number|string>} order The team ids in pick order, one entry per overall pick.
 * @param {number} pickIndex The index of the pick on the clock, from zero.
 * @param {number|string} userTeamId The reader's team.
 * @param {Object<string, Object<string, number>>} needsByTeam Each team's open seats by position.
 * @param {number} [count=5] How many picks to list.
 * @returns {{onTheClock: ?StripPick, picks: StripPick[], thenYou: ?object}} The pick on the clock, the picks after it, and the reader's next turn with how many picks away it is and whether it is among those listed.
 */
export function nextUp(order, pickIndex, userTeamId, needsByTeam, count = 5) {
    const list = order || [];
    const teams = new Set(list.map(String)).size || 1;
    const now = Math.max(0, Math.floor(Number(pickIndex) || 0));
    const needs = needsByTeam || {};
    const openFor = (teamId) => {
        const n = needs[teamId] || needs[String(teamId)] || {};
        return Object.keys(n).filter(pos => Number(n[pos]) > 0).map(pos => ({ position: pos, open: Number(n[pos]) }));
    };
    const at = (i) => ({
        overall: i + 1,
        round: Math.floor(i / teams) + 1,
        pickInRound: (i % teams) + 1,
        teamId: list[i],
        isUser: sameId(list[i], userTeamId),
        needs: openFor(list[i])
    });

    const picks = [];
    for (let i = now + 1; i < list.length && picks.length < Math.max(0, count); i++) picks.push(at(i));

    // The reader's next turn after the one on the clock, whether or not it falls among the picks listed. Null past the last pick.
    let thenYou = null;
    for (let i = now + 1; i < list.length; i++) {
        if (sameId(list[i], userTeamId)) {
            thenYou = { ...at(i), picksAway: i - now, listed: i <= now + picks.length };
            break;
        }
    }
    return { onTheClock: now < list.length ? at(now) : null, picks, thenYou };
}

// ==== (c) The board at a glance: every pick, rounds down and teams across ====

/**
 * Every pick as a grid, rounds down and teams across, for a rehearsal and a logged draft alike.
 * A cell is placed by the pick's index in the list. The columns are the teams in the first round's
 * order and stay put, so a snake draft walks back across the same columns on even rounds.
 *
 * @param {Array<{teamId: *, playerId: *}>} picks The picks made, in draft order.
 * @param {Array<number|string>} order The team ids in pick order.
 * @param {number} rounds How many rounds. Defaults to the order's length over the teams.
 * @param {number} teams How many teams. Defaults to the distinct ids in the order.
 * @param {object} [options]
 * @param {?(number|string)} [options.userTeamId] The reader's team.
 * @param {function(*): ?string} [options.positionOf] A picked player's position.
 * @returns {{rounds: number, teams: Array, userColumn: number, onTheClock: ?number, grid: Array<{round: number, cells: Array<{teamId: *, overall: ?number, playerId: *, position: ?string, filled: boolean, onTheClock: boolean}>}>}}
 *   The grid. A pick the lookup cannot place is still a filled cell, with no position.
 */
export function picksGrid(picks, order, rounds, teams, { userTeamId = null, positionOf = () => null } = {}) {
    const list = order || [];
    const n = Math.max(1, Math.floor(Number(teams) || new Set(list.map(String)).size || 1));
    const r = Math.max(0, Math.floor(Number(rounds) || Math.ceil(list.length / n)));
    const made = picks || [];
    const firstRound = list.slice(0, n);
    const columnOf = new Map(firstRound.map((teamId, c) => [String(teamId), c]));
    // The pick on the clock is the first one not yet made. Past the end of the order nothing is on the clock.
    const clock = made.length < Math.min(list.length, r * n) ? made.length : null;

    const grid = [];
    for (let row = 0; row < r; row++) {
        const cells = firstRound.map(teamId => ({ teamId, overall: null, playerId: null, position: null, filled: false, onTheClock: false }));
        grid.push({ round: row + 1, cells });
    }
    for (let i = 0; i < Math.min(list.length, r * n); i++) {
        const row = Math.floor(i / n);
        const col = columnOf.get(String(list[i]));
        if (col === undefined) continue;   // a team missing from round one has no column to sit in
        const cell = grid[row].cells[col];
        cell.overall = i + 1;
        const pick = made[i];
        if (pick && pick.playerId !== null && pick.playerId !== undefined) {
            cell.filled = true;
            cell.playerId = pick.playerId;
            cell.position = positionOf(pick.playerId) ?? null;
        }
        if (i === clock) cell.onTheClock = true;
    }
    return {
        rounds: r,
        teams: firstRound,
        userColumn: firstRound.findIndex(t => sameId(t, userTeamId)),
        onTheClock: clock === null ? null : clock + 1,
        grid
    };
}

// ==== (d) The run alert is draft-engine.js's runDetect, unchanged ====

// ==== (f) The seat group most at risk ====

/**
 * The margin at or below which a seat group is at risk. A margin is the players above a group's
 * replacement line less the teams picking before the reader who still need that group.
 *
 * @type {number}
 */
export const AT_RISK_MARGIN = 1;

/**
 * The reader's open seat group most at risk before the reader's next pick: the one with the
 * smallest margin between the players still above its replacement line and the teams picking
 * first who need it.
 *
 * @param {object} [args]
 * @param {Object<string, number>} args.openSeats The reader's own open seats by group.
 * @param {object[]} args.remaining The board as it stands.
 * @param {Map|Object<string, *>} args.replacement Each group's replacement line: a number, or draft-engine.js's own entry for the group.
 * @param {StripPick[]} args.picksBefore The turns before the reader's next one, from nextUp.
 * @returns {?{group: string, left: number, needing: number, margin: number, word: string}} Null when the reader has no open seat.
 */
export function seatAtRisk({ openSeats, remaining, replacement, picksBefore } = {}) {
    const open = openSeats || {};
    const groups = Object.keys(open).filter(g => Number(open[g]) > 0);
    if (!groups.length) return null;

    const lineOf = (group) => {
        const entry = replacement instanceof Map ? replacement.get(group) : (replacement || {})[group];
        if (entry === null || entry === undefined) return null;
        if (Number.isFinite(Number(entry))) return Number(entry);
        const p = entry.player;
        if (!p) return null;
        return Number.isFinite(p.value) ? p.value : (Number(p.score) || null);
    };

    const rows = remaining || [];
    const worst = groups.map(group => {
        const line = lineOf(group);
        // A group with no replacement line has nothing to be above, so every one of its players counts.
        const left = rows.filter(row => positionsOf(row).indexOf(group) !== -1)
            .filter(row => {
                if (line === null) return true;
                const v = Number.isFinite(row.value) ? row.value : Number(row.score) || 0;
                return v > line;
            }).length;
        const needing = (picksBefore || []).filter(pick => ((pick && pick.needs) || [])
            .some(n => n && n.position === group && Number(n.open) > 0)).length;
        return { group, left, needing, margin: left - needing };
    }).sort((a, b) => (a.margin - b.margin) || (a.left - b.left))[0];

    const teams = worst.needing === 1 ? '1 team' : `${worst.needing} teams`;
    return {
        ...worst,
        // A fact and its consequence, with no adjective. When nothing is at risk the cell still says so in words, since an empty cell reads as a broken one.
        word: worst.margin > AT_RISK_MARGIN
            ? 'no seat at risk before your pick'
            : `${worst.group} ${MIDDOT} ${worst.left} above the line, ${teams} before you need one`
    };
}

// ==== (e) The verdict against average draft position, as the tag a row prints ====

/**
 * The tag a row prints for a pick against its average draft position, such as 'Value' with the
 * rank and the position beside it. draft-engine.js's verdict decides; this words it once. A player
 * the crowd takes later than the board ranks is printed as a value.
 *
 * @param {number} valueRank The board's rank of the player.
 * @param {number} adp The player's average draft position.
 * @param {object} [opts] Passed to draft-engine.js's adpVerdict.
 * @returns {?{verdict: string, word: ('Value'|'Reach'), text: string}} Null when there is no verdict.
 */
export function adpTag(valueRank, adp, opts) {
    const verdict = adpVerdict(valueRank, adp, opts);
    if (!verdict) return null;
    const word = verdict === 'falling' ? 'Value' : 'Reach';
    return {
        verdict,
        word,
        text: `${word} ${MIDDOT} rank ${valueRank} vs ADP ${Number(adp).toFixed(0)}`
    };
}

/**
 * What the tray's head says while a rehearsal or a followed room is on, and the one shortcut it
 * offers: the plan's next open target.
 *
 * @param {object} [args]
 * @param {boolean} args.isRehearse Whether a rehearsal is on.
 * @param {boolean} args.isFollowingRoom Whether a room is being followed.
 * @param {boolean} args.onTheClock Whether it is the reader's turn.
 * @param {?{id: *, name: string}} [args.nextTarget] The plan's next open target.
 * @returns {?{word: string, action: ?{kind: ('draft'|'taken'), id: *, name: string}}} Null when neither is on.
 */
export function companionHeadState({ isRehearse, isFollowingRoom, onTheClock, nextTarget = null } = {}) {
    if (!isRehearse && !isFollowingRoom) return null;
    const word = isRehearse ? (onTheClock ? 'On the clock' : 'Rehearsing') : 'Following the room';
    // A rehearsal's shortcut is offered only on the reader's own turn. Following a room has no turn to wait for: marking a player taken records what already happened there.
    const canAct = isFollowingRoom || onTheClock;
    if (!nextTarget || !canAct) return { word, action: null };
    return { word, action: { kind: isRehearse ? 'draft' : 'taken', id: nextTarget.id, name: nextTarget.name } };
}

/**
 * An age in words: seconds under a minute, then whole minutes, hours and days, always rounded
 * down.
 *
 * @param {number} seconds The age in seconds.
 * @returns {?string} Such as '59s ago' or '2 h ago'. Null for anything that is not a finite number from zero up.
 */
export function ageWords(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
    const s = Math.floor(seconds);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}
