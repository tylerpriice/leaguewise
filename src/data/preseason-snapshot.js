/**
 * The preseason snapshot: keeping the one figure ESPN does not keep. ESPN's projected totals are a
 * rest-of-season line, replaced once games are played, so the projection a season began with can
 * be recovered by no request. This decides what to store and when; the caller does the storing.
 *
 * A snapshot exists only for a league opened during its preseason. A reader who first opens a
 * league after play has begun has none for that season, and nothing here can change that.
 *
 * Pure. No DOM, no application state, no network and no storage calls.
 *
 * Contract: tests/fixtures/preseason-snapshot.md
 * Tests: tests/preseason-snapshot.test.html
 * @module preseason-snapshot
 */
/**
 * A stored preseason snapshot.
 *
 * @typedef {object} PreseasonSnapshot
 * @property {?number} takenAt When it was taken.
 * @property {?string} sport The sport key.
 * @property {*} leagueId The league.
 * @property {?number} seasonId The season.
 * @property {?number} scoringPeriodId The scoring period it was taken at.
 * @property {?string} takenInState The season state it was taken in, which is what a reader checks.
 * @property {string[]} ids The scored stat ids it holds.
 * @property {Object<string, Object<string, number>>} players Each player's projected line by stat id, keyed by player id.
 */

/**
 * The storage key for a league's snapshot. The sport and the season are in it because a league id
 * is unique across neither.
 *
 * @param {string} sport The sport key.
 * @param {number|string} leagueId The league.
 * @param {number|string} seasonId The season.
 * @returns {string} The key.
 */
export function snapshotKey(sport, leagueId, seasonId) {
    return `preseason:${sport}:${leagueId}:${seasonId}`;
}

/**
 * Which stored snapshots to drop when a new one is written: this league's, other than the current
 * season and the one before. Other leagues' snapshots are never touched.
 *
 * @param {string[]} existingKeys The keys in storage.
 * @param {string} sport The sport key.
 * @param {number|string} leagueId The league.
 * @param {number|string} seasonId The current season.
 * @returns {string[]} The keys to remove.
 */
export function staleKeys(existingKeys, sport, leagueId, seasonId) {
    const year = Number(seasonId);
    if (!Number.isFinite(year)) return [];
    const prefix = `preseason:${sport}:${leagueId}:`;
    return (existingKeys || []).filter(k => {
        if (typeof k !== 'string' || !k.startsWith(prefix)) return false;
        const stored = Number(k.slice(prefix.length));
        // A key whose season does not parse is not judged, so it stays.
        if (!Number.isFinite(stored)) return false;
        return stored !== year && stored !== year - 1;
    });
}

/**
 * Whether to take a snapshot now. Before the draft it is taken on every load, so the stored line
 * is the projection closest to the draft. After the draft and before play it is taken only when
 * none is stored. Once a game is played it is never taken, so the stored line stands.
 *
 * @param {string} seasonState The league's season state.
 * @param {?object} existing The snapshot already stored, if any.
 * @param {object} [options]
 * @param {string[]} [options.preseasonStates] The states in which a snapshot may be taken.
 * @param {string} [options.refreshWhile='pre-draft'] The state in which an existing one is replaced.
 * @returns {boolean} True to take one.
 */
export function shouldTake(seasonState, existing, {
    preseasonStates = ['pre-draft', 'post-draft-preseason'], refreshWhile = 'pre-draft'
} = {}) {
    if (!preseasonStates.includes(seasonState)) return false;
    if (seasonState === refreshWhile) return true;
    return !existing;
}

/**
 * Builds the snapshot to store: only players with a projected line, only the league's scored ids,
 * each figure rounded to three decimals.
 *
 * @param {Array<{id: number, projectedTotals: Object<string, number>}>} pool The player pool.
 * @param {Array<string|number>} scoredIds The league's scored stat ids.
 * @param {{takenAt: number, sport: string, leagueId: *, seasonId: number, scoringPeriodId: number, state: string}} [meta] Where and when it was taken.
 * @returns {?PreseasonSnapshot} The snapshot, or null when there is nothing to store. Never an empty shape.
 */
export function buildSnapshot(pool, scoredIds, meta = {}) {
    const ids = (scoredIds || []).map(String);
    if (!ids.length) return null;
    const wanted = new Set(ids);
    const players = {};
    let kept = 0;
    (pool || []).forEach(p => {
        const line = p && p.projectedTotals;
        if (!line || p.id === undefined || p.id === null) return;
        const row = {};
        let any = false;
        wanted.forEach(id => {
            const v = line[id];
            if (v === undefined || v === null || !Number.isFinite(Number(v))) return;
            row[id] = Math.round(Number(v) * 1000) / 1000;
            any = true;
        });
        if (!any) return;
        players[String(p.id)] = row;
        kept += 1;
    });
    if (!kept) return null;
    return {
        takenAt: meta.takenAt ?? null,
        sport: meta.sport ?? null,
        leagueId: meta.leagueId ?? null,
        seasonId: meta.seasonId ?? null,
        // The period the snapshot was taken at.
        scoringPeriodId: meta.scoringPeriodId ?? null,
        // The season state it was taken in, which is the one that can be checked. The period cannot: a league before its draft reads 0 and a drafted, unplayed one can read 1.
        takenInState: meta.state ?? null,
        ids,
        players
    };
}

/**
 * Whether a stored snapshot was taken in the preseason. A snapshot taken after play began holds a
 * rest-of-season line under a preseason key, so it is refused on reading. A missing or
 * unrecognised state fails closed.
 *
 * @param {?PreseasonSnapshot} snapshot The stored snapshot.
 * @param {object} [options]
 * @param {string[]} [options.preseasonStates] The states that count as preseason.
 * @returns {boolean} True when the snapshot may be shown.
 */
export function isPreseasonSnapshot(snapshot, { preseasonStates = ['pre-draft', 'post-draft-preseason'] } = {}) {
    return !!snapshot && preseasonStates.includes(snapshot.takenInState);
}

/**
 * One player's preseason line from a snapshot.
 *
 * @param {?PreseasonSnapshot} snapshot The stored snapshot.
 * @param {number|string} playerId The player.
 * @returns {?Object<string, number>} The line by stat id. Null for a snapshot that is not a preseason one, and for a player it does not carry, such as one added during the season.
 */
export function preseasonLineFor(snapshot, playerId) {
    if (!isPreseasonSnapshot(snapshot)) return null;
    if (!snapshot.players || playerId === undefined || playerId === null) return null;
    return snapshot.players[String(playerId)] || null;
}
