/**
 * Roster timelines: who owned each player, and who started each player, on each scoring period.
 *
 * Two timelines from two sources. Ownership is replayed from the draft picks and the executed
 * transactions. Starts are read from the daily roster snapshots, each a complete lineup, since
 * that is what a roto standing counts.
 *
 * Pure and the same for every sport and league type. No DOM, no application state and no network;
 * the fetching and caching live elsewhere.
 *
 * Tests: tests/rank-engine.test.html
 * @module roster-timeline
 */
/**
 * The daily roster snapshots: for each scoring period, every team with its players and the slot
 * each sat in that day.
 *
 * @typedef {Object<number, Array<{id: number, entries: Array<{p: number, slot: number}>}>>} RosterDays
 */

const MEMBERSHIP_ITEM_TYPES = new Set(['ADD', 'DROP', 'TRADE']);

// The draft is stamped at period 0, before any real scoring period, so a drafted player is owned from the first day.
const DRAFT_SEED_PERIOD = 0;

/**
 * Builds the ownership timeline from the draft picks and the executed transactions. An add, a
 * drop and a trade each set the player's owner to the team the item moves the player to; a drop
 * moves the player to team 0. Lineup moves and draft items are skipped, and only an executed
 * transaction counts.
 *
 * @param {object} [args]
 * @param {Array<{playerId: number, teamId: number}>} [args.picks] The draft picks.
 * @param {object[]} [args.transactions] The league's transactions, in any order.
 * @returns {Map<number, Array<{period: number, teamId: number}>>} Each player's ownership change points, in period order. A player never drafted or moved is absent.
 */
export function buildRosterTimeline({ picks = [], transactions = [] } = {}) {
    const changesByPlayer = new Map();
    const record = (playerId, period, teamId) => {
        if (playerId == null || teamId == null) return;
        if (!changesByPlayer.has(playerId)) changesByPlayer.set(playerId, []);
        changesByPlayer.get(playerId).push({ period, teamId });
    };

    picks.forEach(p => record(p && p.playerId, DRAFT_SEED_PERIOD, p && p.teamId));

    // Executed transactions are replayed in the order they were proposed. The harvested list is not promised to be chronological, and two changes to one player in one period must apply in the order they happened.
    transactions
        .filter(t => t && t.status === 'EXECUTED')
        .slice()
        .sort((a, b) => (a.proposedDate || 0) - (b.proposedDate || 0))
        .forEach(t => {
            (t.items || []).forEach(item => {
                if (item && MEMBERSHIP_ITEM_TYPES.has(item.type)) {
                    record(item.playerId, t.scoringPeriodId, item.toTeamId);
                }
            });
        });

    // Each player's change points are sorted by period. The sort is stable, so changes within one period keep their order and the last one names the team the period ends on.
    changesByPlayer.forEach(list => list.sort((a, b) => a.period - b.period));
    return changesByPlayer;
}

/**
 * The team that owned a player at a scoring period: the last change point at or before it.
 *
 * @param {Map<number, Array<{period: number, teamId: number}>>} timeline The ownership timeline.
 * @param {number} playerId The player.
 * @param {number} period The scoring period.
 * @returns {number} The team id, or 0 for unrostered.
 */
export function teamForPlayerAtPeriod(timeline, playerId, period) {
    const changes = timeline.get(playerId);
    if (!changes || changes.length === 0) return 0;
    let owner = 0;
    for (const change of changes) {
        if (change.period <= period) owner = change.teamId;
        else break;
    }
    return owner;
}

/**
 * Builds the started timeline from the daily snapshots: a team started a player on a period when
 * that day's snapshot has the player on that team in a starting slot.
 *
 * @param {object} [args]
 * @param {RosterDays} [args.rosterDays] The daily snapshots.
 * @param {Set<number>} args.startingSlots The league's starting slot ids, resolved by the caller.
 * @returns {Map<number, Map<number, number>>} For each player, the team that started the player by period. Only started days are present.
 */
export function buildStartedTimeline({ rosterDays = {}, startingSlots } = {}) {
    const startedByPlayer = new Map();
    const starting = startingSlots || new Set();
    Object.keys(rosterDays).forEach(periodKey => {
        const period = Number(periodKey);
        (rosterDays[periodKey] || []).forEach(team => {
            if (team == null || team.id == null) return;
            (team.entries || []).forEach(e => {
                if (!e || e.p == null || !starting.has(e.slot)) return;
                if (!startedByPlayer.has(e.p)) startedByPlayer.set(e.p, new Map());
                startedByPlayer.get(e.p).set(period, team.id);
            });
        });
    });
    return startedByPlayer;
}

/**
 * The seat a player was started in, per day. A seat has a role, and a two-way player's day counts
 * for the half that belongs to the seat.
 *
 * @param {object} [args]
 * @param {RosterDays} [args.rosterDays] The daily snapshots.
 * @param {Set<number>} args.startingSlots The league's starting slot ids.
 * @returns {Map<number, Map<number, number>>} For each player, the slot by period, on started days only.
 */
export function buildStartedSeats({ rosterDays = {}, startingSlots } = {}) {
    const seatByPlayer = new Map();
    const starting = startingSlots || new Set();
    Object.keys(rosterDays).forEach(periodKey => {
        const period = Number(periodKey);
        (rosterDays[periodKey] || []).forEach(team => {
            if (team == null || team.id == null) return;
            (team.entries || []).forEach(e => {
                if (!e || e.p == null || !starting.has(e.slot)) return;
                if (!seatByPlayer.has(e.p)) seatByPlayer.set(e.p, new Map());
                seatByPlayer.get(e.p).set(period, e.slot);
            });
        });
    });
    return seatByPlayer;
}

/**
 * What a started player's day is credited with: the day's stats, less the ones the seat does not
 * count. The one function for that rule. A value that is not a finite number is left out.
 *
 * @param {Object<string, number>} sums The day's stats by id.
 * @param {number} slot The seat the player was started in.
 * @param {?function(number, string): boolean} [countsFor] Whether a seat is credited with a stat. Absent, the whole line counts.
 * @returns {Object<string, number>} The credited stats.
 */
export function creditedStats(sums, slot, countsFor = null) {
    const counted = typeof countsFor === 'function' ? countsFor : null;
    const out = {};
    Object.keys(sums || {}).forEach(id => {
        if (counted && !counted(slot, id)) return;
        const v = Number(sums[id]);
        if (Number.isFinite(v)) out[id] = v;
    });
    return out;
}

/**
 * Whether every day of a player's season should be kept, in a league that does not keep them for
 * everyone: a player with a probable start listed, or one eligible for a pitching seat. A player
 * with no starter listings at all is never kept.
 *
 * @param {object} [args]
 * @param {?Object<string, string>} [args.starterStatusByProGame] ESPN's starter status by pro game.
 * @param {boolean} [args.pitcherEligible=false] Whether the player can fill a pitching seat.
 * @returns {boolean} True to keep every day.
 */
export function needsEveryDay({ starterStatusByProGame = null, pitcherEligible = false } = {}) {
    const listings = Object.values(starterStatusByProGame || {});
    if (!listings.length) return false;
    return pitcherEligible === true || listings.some(status => status === 'PROBABLE');
}

/**
 * Which of a player's days are worth keeping.
 *
 * @param {number} playerId The player.
 * @param {object} [options]
 * @param {?Set<number>} [options.everyDayIds] The players whose every day is wanted.
 * @param {?Set<number>} [options.rosteredIds] The players on a fantasy roster.
 * @param {?number[]} [options.matchupPeriods] The scoring periods of the matchup being played.
 * @returns {'all'|Set<number>|null} 'all' for every day, the matchup's periods for a rostered player, or null for nothing. A rostered player with no matchup gets null, never 'all'.
 */
export function dayBucketScope(playerId, { everyDayIds = null, rosteredIds = null, matchupPeriods = null } = {}) {
    if (everyDayIds && everyDayIds.has(playerId)) return 'all';
    if (!rosteredIds || !rosteredIds.has(playerId)) return null;
    const periods = (Array.isArray(matchupPeriods) ? matchupPeriods : [])
        .map(Number).filter(p => Number.isFinite(p) && p > 0);
    return periods.length ? new Set(periods) : null;
}

/**
 * Each team's started totals, day by day: a player's day is credited to the team that had the
 * player in a starting seat that day, and only with the stats that seat counts.
 *
 * Three absences are kept apart. A day with no lineup is left out of the periods and listed as
 * missing. A started player whose table was never handed in is listed as unknown. A started
 * player with a table and no line that day did not play, and adds nothing.
 *
 * @param {object} [args]
 * @param {RosterDays} [args.rosterDays] The daily snapshots.
 * @param {Set<number>} args.startingSlots The league's starting slot ids.
 * @param {?(Map|object)} [args.dailyByPlayer] Each player's lines by period, each with its sums and games.
 * @param {number[]} [args.periods] The days asked about, in order.
 * @param {?Iterable} [args.teamIds] Only these teams.
 * @param {?function(number, string): boolean} [args.countsFor] Whether a seat is credited with a stat.
 * @returns {{periods: number[], byTeam: Map<number, Object<number, {sums: Object<string, number>, games: number}>>, missing: number[], unknown: number[]}}
 *   The days with a lineup, each team's totals by day, the days without a lineup, and the started
 *   players with no table.
 */
export function startedDaySums({ rosterDays = {}, startingSlots, dailyByPlayer = null, periods = [], teamIds = null, countsFor = null } = {}) {
    const starting = startingSlots || new Set();
    const wanted = teamIds ? new Set([...teamIds].map(String)) : null;
    const tableOf = (id) => {
        if (!dailyByPlayer) return undefined;
        if (dailyByPlayer instanceof Map) return dailyByPlayer.has(id) ? dailyByPlayer.get(id) : dailyByPlayer.get(String(id));
        return dailyByPlayer[id];
    };
    const byTeam = new Map();
    if (teamIds) [...teamIds].forEach(id => byTeam.set(id, {}));
    const days = [], missing = [], unknown = new Set();

    (Array.isArray(periods) ? periods : []).map(Number).filter(Number.isFinite).forEach(period => {
        const snapshot = (rosterDays || {})[period];
        if (!Array.isArray(snapshot) || !snapshot.length) { missing.push(period); return; }
        days.push(period);
        snapshot.forEach(team => {
            if (!team || team.id == null) return;
            if (wanted && !wanted.has(String(team.id))) return;
            if (!byTeam.has(team.id)) byTeam.set(team.id, {});
            const dest = byTeam.get(team.id);
            (team.entries || []).forEach(e => {
                if (!e || e.p == null || !starting.has(e.slot)) return;
                const table = tableOf(e.p);
                if (table === undefined || table === null) { unknown.add(e.p); return; }
                const line = table[period];
                if (!line) return;
                const bucket = dest[period] || (dest[period] = { sums: {}, games: 0 });
                bucket.games += Number(line.games) || 0;
                const credited = creditedStats(line.sums, e.slot, countsFor);
                Object.keys(credited).forEach(id => { bucket.sums[id] = (bucket.sums[id] || 0) + credited[id]; });
            });
        });
    });
    return { periods: days, byTeam, missing, unknown: [...unknown] };
}

/**
 * A day's sums as fantasy points, by the league's weights. A stat with a figure and no known
 * weight is counted as missing, so a total that left something out says so.
 *
 * @param {Object<string, number>} sums The stats by id.
 * @param {Object<string, ?number>} weights Points per unit by stat id; null for a weight that cannot be known.
 * @returns {{total: number, missing: number}} The points, and how many stats had no weight.
 */
export function weightedTotal(sums, weights) {
    let total = 0, missing = 0;
    Object.keys(weights || {}).forEach(id => {
        const v = Number((sums || {})[id]);
        if (!Number.isFinite(v) || v === 0) return;
        const w = weights[id];
        if (w === null || w === undefined || !Number.isFinite(Number(w))) { missing += 1; return; }
        total += v * Number(w);
    });
    return { total, missing };
}

/**
 * The team that started a player on one scoring period.
 *
 * @param {Map<number, Map<number, number>>} startedByPlayer The started timeline.
 * @param {number} playerId The player.
 * @param {number} period The scoring period.
 * @returns {number} The team id, or 0 when nobody started the player that day.
 */
export function startedTeamForPlayerAtPeriod(startedByPlayer, playerId, period) {
    const byPeriod = startedByPlayer.get(playerId);
    return (byPeriod && byPeriod.get(period)) || 0;
}

/**
 * Every team that ever held each player over one season, first held first. Any stint counts,
 * however short. A drop adds nothing and a second stint with the same team is not counted twice.
 *
 * @param {Map<number, Array<{period: number, teamId: number}>>} timeline The ownership timeline.
 * @returns {Map<number, number[]>} The team ids by player.
 */
export function ownerTeamIdsByPlayer(timeline) {
    const out = new Map();
    if (!timeline || typeof timeline.forEach !== 'function') return out;
    timeline.forEach((changes, playerId) => {
        const seen = [];
        (changes || []).forEach(change => {
            const teamId = change && change.teamId;
            if (!teamId) return;
            if (!seen.includes(teamId)) seen.push(teamId);
        });
        if (seen.length) out.set(playerId, seen);
    });
    return out;
}

// A roster-days file comes in two shapes: wrapped under a days key, or the bare object. The shape is detected and never guessed. A days object is a plain object whose every key is a positive whole number and whose every value is an array. An empty one is a harvest that found nothing, which is an answer.
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function isDaysObject(v) {
    if (!isPlainObject(v)) return false;
    return Object.keys(v).every(k => /^[1-9]\d*$/.test(k) && Array.isArray(v[k]));
}

/**
 * Reads a roster-days file in either of its two shapes.
 *
 * @param {*} data The parsed file.
 * @returns {{days: RosterDays, shape: ('wrapped'|'bare'|'empty'|'unrecognised')}} The snapshots and which shape they came in. Anything else gives no days and 'unrecognised'.
 */
export function rosterDaysOf(data) {
    if (isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, 'days')) {
        // A days key is checked and not trusted. A wrapper around something that is not a days object is not a roster file.
        if (isDaysObject(data.days)) {
            return { days: data.days, shape: Object.keys(data.days).length ? 'wrapped' : 'empty' };
        }
        return { days: {}, shape: 'unrecognised' };
    }
    if (isDaysObject(data)) {
        return { days: data, shape: Object.keys(data).length ? 'bare' : 'empty' };
    }
    return { days: {}, shape: 'unrecognised' };
}
