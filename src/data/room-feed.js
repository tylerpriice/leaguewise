/**
 * What ESPN's draft room reports, and what the pick log makes of it: one protocol line parsed
 * into one fact, those facts merged into draft-plan.js's log, the status a page prints, and the
 * stored snapshot's shape, staleness and redaction.
 *
 * Pure. No DOM, no application state, no storage and no network. It is handed lines and times and
 * hands back objects. Nothing here opens a connection: the reader's own room tab is the only
 * client, and the content script that mirrors its frames is room-reader.js.
 *
 * Contract: tests/fixtures/room-feed.md
 * Tests: tests/room-feed.test.html
 * @module room-feed
 */
/**
 * One thing the room said. Which fields a fact carries depends on its kind.
 *
 * @typedef {object} RoomFact
 * @property {('selected'|'selecting'|'clock'|'joined'|'state'|'autodraft')} kind What the line reported.
 * @property {?number} at When the line arrived, in epoch milliseconds, or null when the caller gave no time.
 * @property {number|string|null} [teamId] The team the fact is about. On a clock fact, the team on the clock or null.
 * @property {number|string} [playerId] selected: the player taken.
 * @property {number} [msRemaining] selecting and clock: the time left, in milliseconds.
 * @property {number} [seq] clock: the room's own sequence figure.
 * @property {number} [n] state: the room's state number, recorded and not interpreted.
 * @property {boolean} [on] autodraft: whether the team's autodraft is on.
 */
/**
 * The snapshot the content script stores for the pages to read. Nothing in this module produces
 * it.
 *
 * @typedef {object} RoomSnapshot
 * @property {?string} status The room's status; 'closed' once the room has closed.
 * @property {number} at When the snapshot was written, in epoch milliseconds.
 * @property {number|string} leagueId The league of the room tab.
 * @property {number} seasonId The season of the room tab.
 * @property {string} sport The sport segment of the room's url.
 * @property {object[]} picks The picks seen so far.
 * @property {object[]} [transports] One row per connection the room page opened. Absent on a snapshot from an older build.
 * @property {object[]} [unknownFrames] Frames the parser could not read, kept as shapes.
 * @property {Object<string, number>} [notNews] Counts of the frames that carry no fact, by verb.
 */
import { emptyLog, applyLoggedPick } from '../engines/draft-plan.js';

// ==== (a) One line of the room's protocol into one fact ====

// The verbs this parse knows were confirmed against a recorded practice room. Two frames are the client's own, SELECT and a two-token AUTODRAFT, and both read as null: this module reports what the room said, and a frame the client sent is not news.

// The wire is text and the pool's ids are numbers, so a token of digits becomes a number and anything else stays a string. The leading minus is for this repository's own fixtures, whose invented ids are negative.
const NUMERIC = /^-?\d+$/;
const idOf = (token) => (NUMERIC.test(token) ? Number(token) : token);

// A quantity, not an id: a clock figure that is not a number makes the whole line unreadable.
const numberOf = (token) => (NUMERIC.test(token) ? Number(token) : null);

const boolOf = (token) => {
    const t = String(token).toLowerCase();
    if (t === 'true' || t === '1' || t === 'on') return true;
    if (t === 'false' || t === '0' || t === 'off') return false;
    return null;
};

const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/**
 * Parses one line of the room's protocol into one fact.
 *
 * @param {string} line The line as it arrived.
 * @param {number} [at] When it arrived, in epoch milliseconds. It is the only time in the system; the room's own clock figures are durations.
 * @returns {?RoomFact} The fact, or null for a line that reports nothing or cannot be read.
 */
export function parseRoomLine(line, at) {
    if (typeof line !== 'string') return null;
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const when = Number.isFinite(at) ? at : null;

    // The verb is read without regard to case and the rest of the line is not touched. No two verbs differ only in case.
    switch (parts[0].toUpperCase()) {
        case 'SELECTED': {
            // The slot is read and discarded: it is the room's lineup decision, and the pool already carries the player's eligibility. A fifth token is discarded too. It appears only on the reader's own pick and identifies a person.
            if (parts.length < 3) return null;
            return { kind: 'selected', teamId: idOf(parts[1]), playerId: idOf(parts[2]), at: when };
        }
        case 'SELECTING': {
            if (parts.length < 3) return null;
            const ms = numberOf(parts[2]);
            return ms === null ? null : { kind: 'selecting', teamId: idOf(parts[1]), msRemaining: ms, at: when };
        }
        case 'CLOCK': {
            if (parts.length < 3) return null;
            const seq = numberOf(parts[1]);
            const ms = numberOf(parts[2]);
            if (seq === null || ms === null) return null;
            // The third token is the team on the clock and is optional. Absent reads as null, so a caller tests one way.
            return { kind: 'clock', seq, msRemaining: ms, teamId: parts.length > 3 ? idOf(parts[3]) : null, at: when };
        }
        case 'JOINED': {
            // The reader's own team, which no other frame states. The id that follows it is discarded here.
            if (parts.length < 2) return null;
            return { kind: 'joined', teamId: idOf(parts[1]), at: when };
        }
        case 'STATE': {
            const n = parts.length < 2 ? null : numberOf(parts[1]);
            return n === null ? null : { kind: 'state', n, at: when };
        }
        case 'AUTODRAFT': {
            // A two-token AUTODRAFT is the client's own frame. The room's carries the team and is the fact; the short form would otherwise read as a team called true.
            if (parts.length < 3) return null;
            const on = boolOf(parts[2]);
            return on === null ? null : { kind: 'autodraft', teamId: idOf(parts[1]), on, at: when };
        }
        // TOKEN, INIT, PING, PONG, AUTOSUGGEST and the client's own SELECT fall through with everything else. None of them says what happened in the draft.
        default: return null;
    }
}

// ==== (b) The room's facts merged into the hand-kept log ====

/**
 * Merges the room's selections into the pick log. Deduplicated by player in arrival order, the
 * room's selections are the draft from pick 1, so the merge rebuilds the log's opening run from
 * them and keeps what the reader logged by hand beyond it. A replayed history adds nothing.
 *
 * A list shorter than the room picks the log already holds is a partial view, and only adds.
 *
 * @param {{picks: object[]}} log The log so far.
 * @param {RoomFact[]} facts Every fact received, in arrival order.
 * @param {object} [options] Accepted and not read. The overall comes from the count of the room's own selections.
 * @returns {{log: {picks: object[]}, added: Array<{overall: number, teamId: *, playerId: *}>, corrected: Array<{overall: number, was: *, now: *}>, dropped: Array<{overall: number, playerId: *}>}}
 *   A new log, each pick marked with its source and time, and what changed. Each change is in
 *   exactly one of the three lists.
 */
export function applyRoomFacts(log, facts, { order, teams } = {}) {
    const held = (log && Array.isArray(log.picks)) ? log.picks : [];

    const placed = new Set();
    const prefix = [];
    (facts || []).forEach(fact => {
        if (!fact || fact.kind !== 'selected') return;
        if (fact.playerId === null || fact.playerId === undefined) return;
        const key = String(fact.playerId);
        if (placed.has(key)) return;
        placed.add(key);
        prefix.push({ teamId: fact.teamId ?? null, playerId: fact.playerId, source: 'room', at: fact.at ?? null });
    });

    // Whether the room's list is the draft from pick 1 or only part of it. A reloaded room page reports only the picks made since, and the protocol carries no pick number to anchor them. So a list shorter than the run of room picks this log already holds is a partial view, and a partial view may only add. A room that shrinks keeps its undone pick here, which a reader can see and clear.
    const heldRoomRun = held.filter(pick => pick && pick.source === 'room').length;
    const partialView = prefix.length < heldRoomRun;

    const dropped = [];
    let wanted;
    if (partialView) {
        // Held picks first, in their own order, every one kept. Then any of the room's that this log has not seen, appended after. Deduplicated by player.
        wanted = [];
        const keptPlayers = new Set();
        [...held].sort((a, b) => Number(a.overall) - Number(b.overall)).forEach(pick => {
            if (!pick || pick.playerId === null || pick.playerId === undefined) return;
            if (keptPlayers.has(String(pick.playerId))) return;
            keptPlayers.add(String(pick.playerId));
            wanted.push({ teamId: pick.teamId ?? null, playerId: pick.playerId, source: pick.source || 'hand', at: pick.at ?? null });
        });
        prefix.forEach(want => {
            if (keptPlayers.has(String(want.playerId))) return;
            keptPlayers.add(String(want.playerId));
            wanted.push(want);
        });
    } else {
        wanted = [...prefix];
        held.forEach(pick => {
            if (!pick || pick.playerId === null || pick.playerId === undefined) return;
            if (Number(pick.overall) <= prefix.length) return;      // the room owns this slot
            if (placed.has(String(pick.playerId))) {
                dropped.push({ overall: Number(pick.overall), playerId: pick.playerId });
                return;
            }
            placed.add(String(pick.playerId));
            wanted.push({ teamId: pick.teamId ?? null, playerId: pick.playerId, source: pick.source || 'hand', at: pick.at ?? null });
        });
    }

    let next = emptyLog();
    wanted.forEach(want => {
        const after = applyLoggedPick(next, { teamId: want.teamId, playerId: want.playerId });
        if (after === next) return;   // refused; the dedupe above means it cannot be, and a silent duplicate is worse
        const appended = after.picks[after.picks.length - 1];
        appended.source = want.source;
        if (want.at !== null && want.at !== undefined) appended.at = want.at;
        next = after;
    });

    // Added and corrected are disjoint: added is an append at an overall the log did not hold, and corrected is a replacement at one it did. A confirmed pick is in neither, and the room's team wins there without a report.
    const before = new Map(held.map(pick => [Number(pick.overall), pick]));
    const added = [];
    const corrected = [];
    next.picks.forEach(pick => {
        const was = before.get(pick.overall);
        if (!was) {
            added.push({ overall: pick.overall, teamId: pick.teamId, playerId: pick.playerId });
            return;
        }
        if (!sameId(was.playerId, pick.playerId)) {
            corrected.push({ overall: pick.overall, was: was.playerId, now: pick.playerId });
        }
    });

    // A new log even when nothing changed. A returned log identical to the one given means a refusal in draft-plan.js, and a merge that added nothing is not one. Every removal is already reported: a held pick the result does not carry sits at an overall the result reaches, so it is in corrected, or beyond the prefix, where it is in dropped.
    return { log: next, added, corrected, dropped };
}

// ==== (c) Where the room is, as a page prints it ====

/**
 * Where the room is: who is on the clock, the time left, when the last pick landed, and how many
 * picks have been made. The team comes from the room; the round and pick come from the count of
 * picks.
 *
 * @param {RoomFact[]} facts Every fact received, in arrival order.
 * @param {object} [options]
 * @param {Array<number|string>} [options.order] The team ids in pick order, used for the team count when teams is not given.
 * @param {number} [options.teams] How many teams draft.
 * @param {number} [options.now] The present, in epoch milliseconds, so the time left counts down.
 * @returns {{onClock: ?{teamId: *, round: ?number, pick: ?number}, msRemaining: ?number, lastPickAt: ?number, picks: number, state: ?number}}
 *   The status. A figure the facts cannot give is null.
 */
export function roomStatus(facts, { order, teams, now } = {}) {
    let lastSelecting = null;
    let lastClock = null;
    let lastState = null;
    let lastPickAt = null;
    const placed = new Set();

    (facts || []).forEach(fact => {
        if (!fact) return;
        if (fact.kind === 'selected') {
            if (fact.playerId === null || fact.playerId === undefined) return;
            const key = String(fact.playerId);
            // A replay must not move the last pick's time. It is when the newest pick was first reported.
            if (placed.has(key)) return;
            placed.add(key);
            if (Number.isFinite(fact.at)) lastPickAt = fact.at;
            return;
        }
        if (fact.kind === 'selecting') { lastSelecting = fact; return; }
        if (fact.kind === 'clock') { lastClock = fact; return; }
        if (fact.kind === 'state') lastState = fact;
    });

    const picks = placed.size;
    const teamCount = Number(teams) > 0
        ? Math.floor(Number(teams))
        : new Set((order || []).map(String)).size;

    // The announcement of a turn is the source of the team on the clock. The clock's own team is the fallback for the time before the first announcement.
    const onTheClock = lastSelecting || (lastClock && lastClock.teamId !== null ? lastClock : null);
    const onClock = onTheClock
        ? {
            teamId: onTheClock.teamId,
            round: teamCount > 0 ? Math.floor(picks / teamCount) + 1 : null,
            pick: teamCount > 0 ? (picks % teamCount) + 1 : null
        }
        : null;

    // The clock figure is whichever of the two arrived later, and a tie goes to the announcement. It then counts down by the time since it arrived and stops at zero. With no present time it is what the room last said.
    let ticking = null;
    if (lastClock && lastSelecting) {
        const a = Number.isFinite(lastClock.at) ? lastClock.at : -Infinity;
        const b = Number.isFinite(lastSelecting.at) ? lastSelecting.at : -Infinity;
        ticking = a > b ? lastClock : lastSelecting;
    } else ticking = lastClock || lastSelecting;

    let msRemaining = null;
    if (ticking && Number.isFinite(ticking.msRemaining)) {
        msRemaining = ticking.msRemaining;
        if (Number.isFinite(now) && Number.isFinite(ticking.at)) {
            msRemaining = Math.max(0, msRemaining - (now - ticking.at));
        }
    }

    // The state number is recorded and not interpreted. Nothing measured maps the number to a meaning.
    return { onClock, msRemaining, lastPickAt, picks, state: lastState ? lastState.n : null };
}

// ==== (d) Whether the stored snapshot is still worth believing ====

/**
 * How old a stored snapshot may be before it is stale, in milliseconds. The content script
 * writes the snapshot on every fact, so one this old means the room has stopped reporting.
 *
 * @type {number}
 */
export const ROOM_STALE_MS = 30000;

/**
 * Whether a stored snapshot should no longer be believed. No snapshot, no time on it and a closed
 * room are all stale.
 *
 * @param {?RoomSnapshot} snapshot The stored snapshot.
 * @param {number} [now] The present, in epoch milliseconds.
 * @returns {boolean} True when the snapshot is missing, closed or older than ROOM_STALE_MS.
 */
export function roomIsStale(snapshot, now = Date.now()) {
    if (!snapshot || snapshot.status === 'closed') return true;
    if (!Number.isFinite(snapshot.at) || !Number.isFinite(now)) return true;
    return (now - snapshot.at) > ROOM_STALE_MS;
}

// A connection's url masked to its host and path. The query is dropped whole, since it carries the token that identifies the reader. Ids in the path are masked too, since a league id there names the league as plainly as a query would. What survives is which host, which endpoint and which transport.
const ENDPOINT_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)/;
const PATH_TOKEN = /^[A-Za-z0-9%_~.=-]{20,}$/;

/**
 * Masks a connection's url to its host and path, with the query dropped and ids in the path
 * replaced by tokens.
 *
 * @param {string} url The url.
 * @returns {?string} The masked host and path, or null for anything with no scheme and host.
 */
export function endpointShape(url) {
    if (typeof url !== 'string') return null;
    const m = ENDPOINT_URL.exec(url.trim());
    // Null, not a guess, for anything with no scheme and host.
    if (!m) return null;
    const host = m[2];
    const segments = (m[3] || '').split('/').map(seg => {
        if (/^game-\d+$/.test(seg)) return 'game-<n>';
        if (/^league-\d+$/.test(seg)) return 'league-<id>';
        // A long segment is a token wherever it sits. Short segments are endpoint names and are kept.
        if (PATH_TOKEN.test(seg)) return '<tok>';
        return seg;
    });
    return host + segments.join('/');
}

/**
 * Which of three things the room is doing: nothing is open, a connection is open and silent, or
 * frames have arrived. The decision is made here and the words belong to the page.
 *
 * @param {?RoomSnapshot} snapshot The stored snapshot.
 * @returns {('none'|'open-no-frames'|'frames')} The state. It is 'frames' once any connection has delivered one.
 */
export function roomFrameState(snapshot) {
    const rows = snapshot && Array.isArray(snapshot.transports) ? snapshot.transports : [];
    if (rows.some(r => r && Number.isFinite(r.firstFrameAt))) return 'frames';
    if (rows.some(r => r && Number.isFinite(r.openedAt))) return 'open-no-frames';
    // A snapshot without the field reads as frames, not as silence. An older build writes no transports at all, and the absence of the field is the absence of the measurement.
    if (snapshot && !Array.isArray(snapshot.transports)) return 'frames';
    return 'none';
}

/**
 * The connection a page should name while the room is open and silent: the one opened most
 * recently.
 *
 * @param {?RoomSnapshot} snapshot The stored snapshot.
 * @returns {?string} The transport's name, or null when nothing opened.
 */
export function openTransportName(snapshot) {
    const rows = snapshot && Array.isArray(snapshot.transports) ? snapshot.transports : [];
    let best = null;
    rows.forEach(r => {
        if (!r || !Number.isFinite(r.openedAt)) return;
        if (!best || r.openedAt > best.openedAt) best = r;
    });
    return best ? (best.transport || null) : null;
}

/**
 * Says whose event this is. The page a draft room lives on opens more than one connection, and
 * only the room's own may speak for the room. The room proves which one it is by sending a frame
 * this protocol understands; until then nothing has been adopted.
 *
 * @param {?string} roomEndpoint The endpoint adopted as the room's, or null when none has been.
 * @param {{endpoint: string}} msg The event, with the masked endpoint it came from.
 * @returns {('room'|'foreign'|'unproven')} 'unproven' while no endpoint is adopted, so the caller parses the frame to find out.
 */
export function classifyRoomEvent(roomEndpoint, msg) {
    if (!msg || typeof msg !== 'object') return 'foreign';
    if (roomEndpoint === null || roomEndpoint === undefined) return 'unproven';
    const from = typeof msg.endpoint === 'string' ? msg.endpoint : null;
    return from !== null && from === roomEndpoint ? 'room' : 'foreign';
}

/**
 * The overall pick a team's selection belongs at, from ESPN's own pick grid: the lowest overall
 * the grid gives that team that the log has not filled. ESPN publishes the order during a live
 * draft, though not the results.
 *
 * @param {Array<{teamId: *, overallPickNumber: number}>} grid The league's pick grid.
 * @param {number|string} teamId The team that picked.
 * @param {Set<number>|number[]} usedOveralls The overalls the log already holds.
 * @returns {?number} The overall, or null when the grid cannot answer.
 */
export function gridOverallFor(grid, teamId, usedOveralls) {
    if (!Array.isArray(grid) || teamId === null || teamId === undefined) return null;
    const used = usedOveralls instanceof Set
        ? usedOveralls
        : new Set((Array.isArray(usedOveralls) ? usedOveralls : []).map(Number));
    let best = null;
    grid.forEach(slot => {
        if (!slot || String(slot.teamId) !== String(teamId)) return;
        const overall = Number(slot.overallPickNumber);
        if (!Number.isFinite(overall) || used.has(overall)) return;
        if (best === null || overall < best) best = overall;
    });
    return best;
}

// ==== (f) The room's own page, when no frame arrived ====

// Every rule above is about frames. This one needs none: the page the reader is on draws the whole draft, so the picks can be recovered from it on demand. No DOM is read here. The content script does the querying and hands in one plain object per cell.
const domNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Reads the cells of the room page's own draft board into placed picks. Each cell states its
 * round and its pick within the round, so the overall is computed from ESPN's own numbers. The
 * column index is never read as a draft position.
 *
 * @param {Array<{round: *, pickInRound: *, row: *, column: *, mine: boolean, firstName: string, lastName: string, proTeam: string, position: string}>} cells One plain object per cell, as the content script read it.
 * @param {object} [options]
 * @param {number} [options.columns] How many picks a round holds. Defaults to the highest column seen.
 * @returns {{columns: number, rounds: number, picks: object[], refused: Array<{reason: string, cell: object}>}}
 *   The picks by overall, the highest round placed, and every cell refused with its reason.
 */
export function boardDomPicks(cells, { columns } = {}) {
    const rows = Array.isArray(cells) ? cells : [];
    const width = domNum(columns) !== null && domNum(columns) >= 1
        ? domNum(columns)
        : rows.reduce((max, cell) => Math.max(max, domNum(cell && cell.column) || 0), 0);
    const picks = [];
    const refused = [];
    const seen = new Map();
    const refuse = (reason, cell) => refused.push({ reason, cell });

    rows.forEach(cell => {
        if (!cell) return;
        const round = domNum(cell.round);
        const pickInRound = domNum(cell.pickInRound);
        if (round === null || round < 1) return refuse('no-round', cell);
        if (pickInRound === null || pickInRound < 1) return refuse('no-pick-in-round', cell);
        if (!width || pickInRound > width) return refuse('pick-out-of-range', cell);
        const row = domNum(cell.row);
        // The page is checked against itself where it can be. The grid row and the text agree on every cell measured, so a disagreement is a page this code does not understand, not a pick.
        if (row !== null && row !== round) return refuse('round-disagrees', cell);
        const overall = (round - 1) * width + pickInRound;
        if (seen.has(overall)) return refuse('duplicate-overall', cell);
        const first = String(cell.firstName ?? '').trim();
        const last = String(cell.lastName ?? '').trim();
        const pick = {
            overall,
            round,
            pickInRound,
            column: domNum(cell.column),
            mine: cell.mine === true,
            // A cell with no name is still a placed pick, and is reported later as unresolved.
            name: `${first} ${last}`.trim(),
            firstName: first,
            lastName: last,
            proTeam: String(cell.proTeam ?? '').trim(),
            position: String(cell.position ?? '').trim()
        };
        seen.set(overall, pick);
        picks.push(pick);
    });

    picks.sort((a, b) => a.overall - b.overall);
    // The highest round placed, never the league's own round count.
    const rounds = picks.reduce((max, pick) => Math.max(max, pick.round), 0);
    return { columns: width, rounds, picks, refused };
}

// The grid decides the team, since ESPN publishes the order for the whole draft. Whole means every overall from 1 to the slot count present, each with a team. A grid with a hole is not trusted at all, and the column's label is the fallback.
function wholeGridTeams(grid) {
    if (!Array.isArray(grid) || !grid.length) return null;
    const byOverall = new Map();
    for (const slot of grid) {
        const overall = domNum(slot && slot.overallPickNumber);
        if (overall === null || overall < 1) return null;
        if (byOverall.has(overall)) return null;
        if (slot.teamId === null || slot.teamId === undefined) return null;
        byOverall.set(overall, slot.teamId);
    }
    for (let overall = 1; overall <= byOverall.size; overall++) {
        if (!byOverall.has(overall)) return null;
    }
    return byOverall;
}

/**
 * Turns picks read off the page into selection facts for the merge. The page carries a name and
 * no player id, so the caller's lookup resolves each pick.
 *
 * The facts are the unbroken run from overall 1 and stop at the first overall that is missing or
 * unresolved, since the merge numbers facts by position. A resolved pick past that point is
 * returned apart: it may not enter the log by position, but its player is still taken.
 *
 * @param {object[]} picks The picks from boardDomPicks.
 * @param {object} [options]
 * @param {function(object): *} [options.playerIdOf] Resolves a pick to a player id, or null.
 * @param {function(object): *} [options.teamIdOf] Resolves a pick's column to a team id.
 * @param {object[]} [options.grid] The league's pick grid, which decides the team when it is whole.
 * @returns {{facts: RoomFact[], unresolved: object[], held: object[], teamMismatches: object[], teamSource: ('grid'|'column'|'none')}}
 *   The facts, the picks with no player, the resolved picks past the run, and where the grid and
 *   the column disagreed on the team.
 */
export function domPickFacts(picks, { playerIdOf, teamIdOf, grid } = {}) {
    const rows = Array.isArray(picks) ? [...picks].sort((a, b) => a.overall - b.overall) : [];
    const gridTeams = wholeGridTeams(grid);
    const teamSource = gridTeams ? 'grid' : (typeof teamIdOf === 'function' ? 'column' : 'none');

    const resolved = [];
    const unresolved = [];
    const teamMismatches = [];
    rows.forEach(pick => {
        if (!pick || domNum(pick.overall) === null) return;
        const overall = domNum(pick.overall);
        const raw = typeof playerIdOf === 'function' ? playerIdOf(pick) : null;
        const playerId = raw === null || raw === undefined || Number(raw) === -1 ? null : raw;
        const columnTeam = typeof teamIdOf === 'function' ? (teamIdOf(pick) ?? null) : null;
        const gridTeam = gridTeams && gridTeams.has(overall) ? gridTeams.get(overall) : null;
        if (gridTeam !== null && columnTeam !== null && String(gridTeam) !== String(columnTeam)) {
            teamMismatches.push({ overall, grid: gridTeam, column: columnTeam });
        }
        const teamId = gridTeam !== null ? gridTeam : columnTeam;
        if (playerId === null) {
            unresolved.push({ overall, name: pick.name ?? '', teamId });
            return;
        }
        resolved.push({ overall, teamId, playerId });
    });

    const byOverall = new Map(resolved.map(row => [row.overall, row]));
    const facts = [];
    for (let overall = 1; byOverall.has(overall); overall++) {
        const row = byOverall.get(overall);
        // The same shape parseRoomLine gives a selection, so the merge is unchanged. The time is null because a page says what was picked and never when.
        facts.push({ kind: 'selected', teamId: row.teamId, playerId: row.playerId, at: null });
    }
    const held = resolved.filter(row => row.overall > facts.length);
    return { facts, unresolved, held, teamMismatches, teamSource };
}

// ==== (g) The snapshot as a diagnostic kind ====

// A diagnostic export keeps a frame's shape and never its text: the verb, then one token per field saying what kind of thing it was. A line the parser returns null for can carry the reader's session ids. The pattern is anchored, and a field joined by colons is split before its parts are tested.
const FRAME_GUID = /^\{[0-9a-fA-F-]{8,}\}$/;
const FRAME_TOKENISH = /^[A-Za-z0-9+/=_-]{16,}$/;

// A JSON envelope's keys are classified too, since an object keyed by an id would print ids as its keys. A key is treated as a token only when it also carries a digit or one of + / =, so a long name is kept.
const KEY_GUID_BARE = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
function classifyFrameKey(key) {
    const k = String(key);
    if (/^-?\d+$/.test(k)) return '<n>';
    if (FRAME_GUID.test(k)) return '{<guid>}';
    if (KEY_GUID_BARE.test(k)) return '<guid>';
    if (FRAME_TOKENISH.test(k) && /[0-9+/=]/.test(k)) return '<tok>';
    return k;
}

/**
 * Reduces a frame's text to its shape: the verb, then one token per field saying what kind of
 * thing it was. A JSON envelope is reduced to its top-level keys.
 *
 * @param {string} text The frame's text.
 * @returns {string} The shape. Empty for no text.
 */
export function redactFrameData(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (!trimmed) return '';
    // A JSON envelope: its keys say what the frame is about and its values are where anything secret would be. Keys only, capped, and one level deep.
    if (trimmed[0] === '{' || trimmed[0] === '[') {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return `json:array(${parsed.length})`;
            const keys = Object.keys(parsed).slice(0, 8).map(classifyFrameKey);
            return `json:{${keys.join(',')}}`;
        } catch {
            return 'json-like:unparsed';
        }
    }
    const parts = trimmed.split(/\s+/);
    // The verb is kept as written and nothing else is. A protocol verb names no league and no person.
    const verb = /^[A-Z]{2,}$/.test(parts[0]) ? parts[0] : '<word>';
    const fields = parts.slice(1).map(field => {
        // A field joined by colons is split before anything else is asked of it, since every part of it is an id.
        if (field.includes(':')) return field.split(':').map(bit => {
            if (FRAME_GUID.test(bit)) return '{<guid>}';
            if (/^-?\d+$/.test(bit)) return '<n>';
            return FRAME_TOKENISH.test(bit) ? '<tok>' : '<word>';
        }).join(':');
        if (FRAME_GUID.test(field)) return '{<guid>}';
        if (/^-?\d+$/.test(field)) return '<n>';
        if (FRAME_TOKENISH.test(field)) return '<tok>';
        return '<word>';
    });
    return [verb, ...fields].join(' ');
}

/**
 * The stored snapshot as one diagnostic kind. Frames are exported as shapes and never as text.
 *
 * The room tab's league is not always the one the dashboard has loaded. The export says whether
 * they match, and when they do not the pick list is withheld and its count reported, so the
 * export never carries a second league's draft. The sport is not part of the comparison, since
 * the two sides name it differently.
 *
 * @param {?RoomSnapshot} snapshot The stored snapshot.
 * @param {object} [options]
 * @param {{leagueId: *, seasonId: *}} [options.loaded] The league the dashboard has loaded.
 * @param {number} [options.now] The present, in epoch milliseconds.
 * @returns {?object} The export, or null for no snapshot.
 */
export function roomSnapshotExport(snapshot, { loaded = null, now = Date.now() } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const transports = Array.isArray(snapshot.transports) ? snapshot.transports : [];
    const picks = Array.isArray(snapshot.picks) ? snapshot.picks : [];
    const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);
    // A caller that cannot say which league is loaded has not said this one is, so no loaded league means no match.
    const matchesLoaded = !!loaded
        && sameId(snapshot.leagueId, loaded.leagueId)
        && sameId(snapshot.seasonId, loaded.seasonId);
    const at = Number.isFinite(Number(snapshot.at)) ? Number(snapshot.at) : null;
    return {
        league: {
            leagueId: snapshot.leagueId ?? null,
            seasonId: snapshot.seasonId ?? null,
            sport: snapshot.sport ?? null,
            matchesLoaded
        },
        status: snapshot.status ?? null,
        at,
        ageMs: at === null ? null : Math.max(0, Number(now) - at),
        stale: roomIsStale(snapshot, now),
        // The frame state and the open transport come from the functions that already decide them, so the export and a page cannot disagree about a silent room.
        frameState: roomFrameState(snapshot),
        openTransport: openTransportName(snapshot),
        facts: {
            picks: picks.length,
            lastPickAt: snapshot.lastPickAt ?? null,
            onClock: snapshot.onClock ?? null,
            msRemaining: snapshot.msRemaining ?? null,
            myTeamId: snapshot.myTeamId ?? null
        },
        // Every field of a transport row is a count, a time, a ready state or an endpoint masked before the content script saw it.
        transports: transports.map(row => ({
            transport: row && row.transport !== undefined ? row.transport : null,
            endpoint: row && row.endpoint !== undefined ? row.endpoint : null,
            isRoom: (row && row.isRoom) === true,
            openedAt: row && row.openedAt !== undefined ? row.openedAt : null,
            firstFrameAt: row && row.firstFrameAt !== undefined ? row.firstFrameAt : null,
            frames: Number(row && row.frames) || 0,
            event: row && row.event !== undefined ? row.event : null,
            lastErrorAt: row && row.lastErrorAt !== undefined ? row.lastErrorAt : null,
            lastReadyState: row && row.lastReadyState !== undefined ? row.lastReadyState : null
        })),
        // A shape where there is one, and a redaction where there is not. A snapshot written by an older build may still hold a frame's text, so it is redacted on the way out.
        unknownFrames: (Array.isArray(snapshot.unknownFrames) ? snapshot.unknownFrames : []).map(frame => ({
            transport: frame && frame.transport !== undefined ? frame.transport : null,
            event: frame && frame.event !== undefined ? frame.event : null,
            at: frame && frame.at !== undefined ? frame.at : null,
            // NEVER `data`. The shape, and the field name says which it is.
            shape: frame && typeof frame.shape === 'string' ? frame.shape : redactFrameData(frame && frame.data),
            chars: Number.isFinite(Number(frame && frame.chars))
                ? Number(frame.chars)
                : (typeof (frame && frame.data) === 'string' ? frame.data.length : 0)
        })),
        // The verbs that carry no fact, as counts. An older snapshot has no such field and reads as an empty list.
        notNews: (() => {
            const counts = snapshot.notNews && typeof snapshot.notNews === 'object' ? snapshot.notNews : {};
            return Object.keys(counts).map(verb => ({ verb, count: Number(counts[verb]) || 0 }));
        })(),
        picks: matchesLoaded
            ? picks.map(p => ({ overall: p.overall ?? null, teamId: p.teamId ?? null, playerId: p.playerId ?? null, at: p.at ?? null }))
            : null,
        picksWithheld: matchesLoaded ? 0 : picks.length
    };
}

// ==== (h) Redacted at rest, and not only at export ====

/**
 * The verbs that carry no fact about the draft: the room's sign-in and opening lines, the
 * keep-alive pair, the room's suggestion, and the client's own pick request. They are counted and
 * never stored, since one of them can carry the reader's session ids.
 *
 * @type {string[]}
 */
export const ROOM_NOT_NEWS = ['TOKEN', 'INIT', 'PING', 'PONG', 'AUTOSUGGEST', 'SELECT'];

/**
 * Sorts a line into a fact, a line that is not news, or one that could not be read. A verb the
 * parser knows but could not read is unreadable, which is what a diagnosis needs to see.
 *
 * @param {string} line The line.
 * @returns {{kind: ('fact'|'not-news'|'unreadable'), verb: ?string}} The class and the verb in capitals, when the line opens with one.
 */
export function roomFrameClass(line) {
    if (typeof line !== 'string' || !line.trim()) return { kind: 'unreadable', verb: null };
    const first = line.trim().split(/\s+/)[0] || '';
    const verb = /^[A-Za-z]{2,}$/.test(first) ? first.toUpperCase() : null;
    if (parseRoomLine(line, null)) return { kind: 'fact', verb };
    if (verb !== null && ROOM_NOT_NEWS.indexOf(verb) !== -1) return { kind: 'not-news', verb };
    return { kind: 'unreadable', verb };
}

/**
 * Adds one frame to the buffer of frames the parser could not use. A line that is not news is
 * counted and dropped. Anything else is kept as its shape and its length, never its text, up to
 * the cap.
 *
 * @param {?{frames: object[], notNews: Object<string, number>}} buffer The buffer so far.
 * @param {{data: string, transport: string, event: string, at: number}} frame The frame.
 * @param {object} [options]
 * @param {number} [options.cap=8] The most shapes the buffer holds.
 * @returns {{frames: object[], notNews: Object<string, number>}} The buffer after the frame.
 */
export function bufferFrame(buffer, frame, { cap = 8 } = {}) {
    const frames = buffer && Array.isArray(buffer.frames) ? buffer.frames : [];
    const notNews = buffer && buffer.notNews && typeof buffer.notNews === 'object' ? buffer.notNews : {};
    if (!frame) return { frames, notNews };
    const data = typeof frame.data === 'string' ? frame.data : '';
    const { kind, verb } = roomFrameClass(data);
    if (kind === 'not-news') {
        const key = verb || 'unknown';
        // A count has no cap. The cap belongs to the buffer of shapes.
        return { frames, notNews: { ...notNews, [key]: (notNews[key] || 0) + 1 } };
    }
    if (frames.length >= cap) return { frames, notNews };
    return {
        notNews,
        frames: [...frames, {
            transport: typeof frame.transport === 'string' ? frame.transport : 'unknown',
            event: typeof frame.event === 'string' ? frame.event : null,
            at: frame.at ?? null,
            shape: redactFrameData(data),
            chars: data.length
        }]
    };
}
