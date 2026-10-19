/**
 * The reader's own rankings or tiers, read from a file and set beside the Draft tab's board. It
 * reads the file, matches its rows to the league's player pool, and gives the board a column to
 * print. The same matching resolves a name read off ESPN's draft room page to a player.
 *
 * A name that fits more than one player is reported and never guessed.
 *
 * Pure. No DOM, no application state, no storage and no network. It imports only delimited.js.
 *
 * Contract: tests/fixtures/rankings-file.md
 * Tests: tests/rankings-file.test.html
 * @module rankings-file
 */
/**
 * One player in the pool, as these functions read it.
 *
 * @typedef {object} PoolEntry
 * @property {{id: (number|string), fullName: string, proTeamId: number}} player The player.
 */
import { readDelimited, normalizeName } from './delimited.js';

// ==== (a) Reading the file ====

// Headers are matched without regard to case, spaces or punctuation, since a reader's own file follows no specification. The order here is the order the columns found are reported in.
const ALIASES = {
    name: ['player', 'name', 'playername'],
    club: ['team', 'club', 'tm'],
    position: ['pos', 'position'],
    rank: ['rank', 'rk', 'overall', 'adp'],
    tier: ['tier'],
    espnId: ['id', 'espnid', 'playerid']
};

const fold = h => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, '');

const numberOrNull = (text) => {
    if (text === undefined || text === null) return null;
    const s = String(text).trim().replace(/,/g, '');
    if (s === '') return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;   // undefined MEANS unreadable
    return Number(s);
};

/**
 * Reads a rankings file. The columns are found by name, under several common spellings: a name,
 * a club, a position, a rank, a tier and an ESPN player id.
 *
 * @param {string} text The file's text.
 * @returns {{rows: Array<{name: string, club: string, position: string, rank: ?number, tier: ?number, espnId: ?string}>, columnsFound: Object<string, ?string>, issues: Array<{row: ?number, why: string}>}}
 *   The rows, the file's own header for each field found, and what was dropped or could not be
 *   read.
 */
export function readRankings(text) {
    const file = readDelimited(text);
    const headers = file.headers || [];
    const issues = [];

    // The file's own header is reported, not the field name, so a page can say which column it read. The first matching header wins.
    const columnsFound = {};
    Object.keys(ALIASES).forEach(field => {
        const hit = headers.find(h => ALIASES[field].includes(fold(h)));
        columnsFound[field] = hit === undefined ? null : hit;
    });
    const at = (row, header) => {
        const i = headers.indexOf(header);
        return i === -1 ? '' : String(row[i] === undefined ? '' : row[i]).trim();
    };

    // With neither a name nor an id there is nothing to match on, and an empty list is returned.
    if (!columnsFound.name && !columnsFound.espnId) {
        issues.push({ row: null, why: 'no Player, Name or ID column - nothing to match a ranking to' });
        return { rows: [], columnsFound, issues };
    }

    const rows = [];
    (file.rows || []).forEach((r, i) => {
        const name = columnsFound.name ? at(r, columnsFound.name) : '';
        const espnId = columnsFound.espnId ? at(r, columnsFound.espnId) : '';
        // A row with neither a name nor an id cannot be matched. It is counted, so the reader is told how many were dropped.
        if (!name && !espnId) { issues.push({ row: i + 1, why: 'no name and no id' }); return; }

        const readNumber = (field) => {
            if (!columnsFound[field]) return null;
            const v = numberOrNull(at(r, columnsFound[field]));
            if (v === undefined) {
                issues.push({ row: i + 1, why: `${field} "${at(r, columnsFound[field])}" is not a number` });
                return null;
            }
            return v;
        };

        rows.push({
            name,
            club: columnsFound.club ? at(r, columnsFound.club) : '',
            position: columnsFound.position ? at(r, columnsFound.position) : '',
            rank: readNumber('rank'),
            tier: readNumber('tier'),
            espnId: espnId || null
        });
    });

    return { rows, columnsFound, issues };
}

// ==== (b) Matching them to the pool ====

/**
 * Matches a file's rows to the pool: by id where the file carries one, then by normalized name,
 * with the club and then the position to separate players who share a name.
 *
 * The pool stores a club as an id and a file names it in letters, so the caller supplies the
 * translation. With none given the club step is skipped, and what it would have separated is
 * reported as ambiguous.
 *
 * @param {object[]} rows The rows from readRankings.
 * @param {PoolEntry[]} pool The league's player pool.
 * @param {object} [options]
 * @param {function((number|string)): string[]} [options.positionsOf] A player's positions, by id.
 * @param {function(PoolEntry): string} [options.clubOf] A pool entry's club, as a file would write it.
 * @returns {{byPlayerId: Object<string, {rank: ?number, tier: ?number}>, unmatched: object[], ambiguous: Array<{row: object, candidates: Array}>}}
 *   The rank and tier by player id, the rows matching nobody, and the rows fitting more than one
 *   player.
 */
export function matchRankings(rows, pool, { positionsOf = null, clubOf = null } = {}) {
    const clubFor = typeof clubOf === 'function' ? clubOf : null;
    const posFor = positionsOf || (() => []);

    const byId = new Map();
    const byName = new Map();
    (pool || []).forEach(entry => {
        const p = (entry && entry.player) || {};
        if (p.id === undefined || p.id === null) return;
        byId.set(String(p.id), entry);
        const n = normalizeName(p.fullName);
        if (!n) return;
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(entry);
    });

    const idOf = entry => (entry && entry.player && entry.player.id);
    const byPlayerId = {};
    const unmatched = [];
    const ambiguous = [];

    (rows || []).forEach(row => {
        // 1. The id is the file saying exactly who it means, and no name comparison beats it.
        if (row.espnId && byId.has(String(row.espnId))) {
            byPlayerId[String(row.espnId)] = { rank: row.rank ?? null, tier: row.tier ?? null };
            return;
        }

        const n = normalizeName(row.name);
        const candidates = (n && byName.get(n)) || [];
        if (!candidates.length) { unmatched.push(row); return; }

        let hit = candidates.length === 1 ? candidates[0] : null;

        // 2. The club separates a shared name, where the file gives one.
        if (!hit && row.club && clubFor) {
            const want = normalizeName(row.club);
            const narrowed = candidates.filter(c => normalizeName(clubFor(c)) === want);
            if (narrowed.length === 1) hit = narrowed[0];
        }
        // 3. Then the position, for a file with no club column or a club that did not decide.
        if (!hit && row.position) {
            const want = normalizeName(row.position);
            const narrowed = candidates.filter(c => (posFor(idOf(c)) || [])
                .some(p => normalizeName(p) === want));
            if (narrowed.length === 1) hit = narrowed[0];
        }

        // Neither gets the rank. Which of two players a reader meant is not guessed.
        if (!hit) { ambiguous.push({ row, candidates: candidates.map(idOf) }); return; }

        // A later row wins. A file naming the same player twice is taken at its last word.
        byPlayerId[String(idOf(hit))] = { rank: row.rank ?? null, tier: row.tier ?? null };
    });

    return { byPlayerId, unmatched, ambiguous };
}

// ==== (d) The same matching, for a board read off ESPN's draft room page ====

/**
 * The positions each position label on ESPN's draft room page stands for. The page labels hockey
 * players by group, so a label is expanded to the positions it covers before it is compared. A
 * label not in the map narrows nothing.
 *
 * @type {Object<string, string[]>}
 */
export const ROOM_POSITION_GROUPS = { F: ['C', 'LW', 'RW', 'F'], D: ['D'], G: ['G'] };

/**
 * Builds the lookup that resolves a pick read off the draft room page to a player id: by
 * normalized name, then the club, then the position by group. The page carries a name and no id.
 *
 * With no club translation the club step is skipped.
 *
 * @param {PoolEntry[]} pool The league's player pool.
 * @param {object} [options]
 * @param {function((number|string)): string[]} [options.positionsOf] A player's positions, by id.
 * @param {function(PoolEntry): string} [options.clubOf] A pool entry's club abbreviation.
 * @param {Object<string, string[]>} [options.groups] The position groups. Defaults to ROOM_POSITION_GROUPS.
 * @returns {{playerIdOf: function(object): ?(number|string), unmatched: object[], ambiguous: object[]}}
 *   The lookup, and two lists it fills as it is called: the names matching nobody and the names
 *   fitting more than one player.
 */
export function poolNameLookup(pool, { positionsOf = null, clubOf = null, groups = ROOM_POSITION_GROUPS } = {}) {
    const clubFor = typeof clubOf === 'function' ? clubOf : null;
    const posFor = positionsOf || (() => []);
    const idOf = entry => (entry && entry.player && entry.player.id);

    const byName = new Map();
    (pool || []).forEach(entry => {
        const p = (entry && entry.player) || {};
        if (p.id === undefined || p.id === null) return;
        const n = normalizeName(p.fullName);
        if (!n) return;
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(entry);
    });

    const groupFor = (label) => {
        const want = normalizeName(label);
        if (!want) return null;
        const key = Object.keys(groups || {}).find(g => normalizeName(g) === want);
        return key ? (groups[key] || []).map(normalizeName) : null;
    };

    // The names that could not be resolved are kept beside the lookup and read after the pass, since a null answer does not say whether nobody has the name or two players share it.
    const unmatched = [];
    const ambiguous = [];

    function playerIdOf(pick) {
        const n = normalizeName(pick && pick.name);
        const candidates = (n && byName.get(n)) || [];
        if (!candidates.length) {
            if (n) unmatched.push({ name: pick.name, overall: pick.overall ?? null });
            return null;
        }
        let hit = candidates.length === 1 ? candidates[0] : null;

        // The club first, as in matchRankings.
        if (!hit && pick.proTeam && clubFor) {
            const want = normalizeName(pick.proTeam);
            const narrowed = candidates.filter(c => normalizeName(clubFor(c)) === want);
            if (narrowed.length === 1) hit = narrowed[0];
        }
        // Then the position, by group.
        if (!hit && pick.position) {
            const wanted = groupFor(pick.position);
            if (wanted) {
                const narrowed = candidates.filter(c => (posFor(idOf(c)) || [])
                    .some(p => wanted.indexOf(normalizeName(p)) !== -1));
                if (narrowed.length === 1) hit = narrowed[0];
            }
        }
        if (!hit) {
            ambiguous.push({ name: pick.name, overall: pick.overall ?? null, candidates: candidates.map(idOf) });
            return null;
        }
        return idOf(hit);
    }

    return { playerIdOf, unmatched, ambiguous };
}

// ==== (c) The column the board prints ====

/**
 * The column the board prints beside its own ranks. The board's order as handed in is its rank,
 * and nothing here sorts it again.
 *
 * The difference is the file's rank less the board's, so a negative figure means the reader rates
 * the player higher than the board does.
 *
 * @param {Object<string, {rank: ?number, tier: ?number}>} byPlayerId The ranks from matchRankings.
 * @param {object[]} boardRows The board's rows, in the order shown.
 * @returns {Array<{playerId: *, myRank: ?number, myTier: ?number, boardRank: number, deltaVsBoard: ?number}>} One entry per row. A player the file does not rank has nulls.
 */
export function rankingsColumn(byPlayerId, boardRows) {
    const found = byPlayerId || {};
    return (boardRows || []).map((row, i) => {
        const playerId = (row && row.player && row.player.id !== undefined)
            ? row.player.id
            : (row && row.id !== undefined ? row.id : row);
        const mine = found[String(playerId)];
        const boardRank = i + 1;
        if (!mine) {
            // No opinion is not agreement, so these are nulls. A zero difference would read as the reader agreeing exactly.
            return { playerId, myRank: null, myTier: null, boardRank, deltaVsBoard: null };
        }
        return {
            playerId,
            myRank: mine.rank ?? null,
            myTier: mine.tier ?? null,
            boardRank,
            deltaVsBoard: mine.rank === null || mine.rank === undefined ? null : mine.rank - boardRank
        };
    });
}
