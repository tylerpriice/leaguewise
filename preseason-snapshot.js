// PURE. THE PRESEASON SNAPSHOT: keeping the one number ESPN will not keep for us. No DOM, no AppState, no fetches, no storage calls - it decides WHAT to store and WHEN, and the caller does the storing. The rule every pure module here follows, and the reason this one can be tested at all: storage is the least testable thing in an extension. WHY IT EXISTS. projectedTotals is ESPN's REST-OF-SEASON line (measured, item 10 and tests/fixtures/projection-pacing.md), refetched every session. The moment a game is played, the preseason projection is gone - overwritten, not archived, and no request brings it back. So "pacing above the preseason projection" is unanswerable once a season starts unless somebody wrote the number down before it did. This writes it down. THE FEATURE CAN NEVER BE RETROACTIVE, which is the honest limit and belongs at the top of the file rather than in a footnote: a snapshot exists only for a league opened during its preseason. A reader who installs in October has none for that season, ever. Nothing here can change that.

// The key. Sport and season are in it because a league id is unique across NEITHER - the same trap proScheduleKey exists to close, where an NFL club map read as a baseball one and printed a plausible wrong club.
export function snapshotKey(sport, leagueId, seasonId) {
    return `preseason:${sport}:${leagueId}:${seasonId}`;
}

// Which stored snapshots to drop when a new one is written: everything for this league but the current season and the one before it. SCOPED TO THE LEAGUE, deliberately. A reader's other leagues are not this write's business, and a retention pass that reached across them would delete another league's only snapshot on the day this one happened to be opened.
export function staleKeys(existingKeys, sport, leagueId, seasonId) {
    const year = Number(seasonId);
    if (!Number.isFinite(year)) return [];
    const prefix = `preseason:${sport}:${leagueId}:`;
    return (existingKeys || []).filter(k => {
        if (typeof k !== 'string' || !k.startsWith(prefix)) return false;
        const stored = Number(k.slice(prefix.length));
        // A key whose season does not parse is not ours to judge, so it stays. Deleting something unrecognised is how a stray format becomes lost data.
        if (!Number.isFinite(stored)) return false;
        return stored !== year && stored !== year - 1;
    });
}

// WHETHER TO TAKE ONE AT ALL. Both halves matter and they are different questions. TAKEN ONCE. A snapshot rewritten after a game has been played stores the rest-of-season line - exactly the number the snapshot exists to be an alternative to - and it would do so silently, leaving a key that looks like a preseason projection and is not. So an existing snapshot is never replaced, even when the league is somehow still preseason.
export function shouldTake(seasonState, existing, { preseasonStates = ['pre-draft', 'post-draft-preseason'] } = {}) {
    if (existing) return false;
    return preseasonStates.includes(seasonState);
}

// WHAT IS STORED. Only players carrying a source-1 line, only the league's scored ids, rounded. SCORED IDS ONLY, MEASURED: on real captures that is 70 KB rather than 271 KB for a 3,000-player baseball pool, 53 KB against 262 KB for football - a 74 to 80% saving, because ESPN's line carries every id it knows and a league scores a dozen of them. An id no surface can read is weight without a reader. THREE DECIMALS, because no surface prints more and a projection is a round guess: full precision costs a third again in football, where the line runs to nine decimal places. NULL WHEN THERE IS NOTHING TO STORE, never an empty shape - a stored `{}` reads as "we took a snapshot and the league had nobody", which is not a thing that happens and would stop a later attempt that could have succeeded.
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
        // The period the snapshot was taken at, so a reader can tell a genuine preseason capture from one taken by a future bug after play started.
        scoringPeriodId: meta.scoringPeriodId ?? null,
        // AND THE SEASON STATE IT WAS TAKEN IN, which is the one that can be CHECKED. The period cannot be: a pre-draft league reads 0 and a drafted-but-unplayed one can read 1, so "period > 0" would reject a legitimate snapshot. The state is unambiguous.
        takenInState: meta.state ?? null,
        ids,
        players
    };
}

// WHETHER A STORED SNAPSHOT IS ACTUALLY A PRESEASON ONE, and this guard exists because staging the read path showed exactly what its absence looks like: a snapshot built from a mid-season pool stores the REST-OF-SEASON line under a preseason key, and the surface then prints "before the season, ESPN projected 6" about a player who already has 30. The number is not wrong, it is answering a different question, and nothing on screen would say so. shouldTake already refuses to write one after play starts. This refuses to READ one - a snapshot written by an older build, or by a bug, or restored from another machine's storage, is not something the write path can un-write. An unrecognised or missing state fails CLOSED: a snapshot that cannot prove when it was taken is not shown.
export function isPreseasonSnapshot(snapshot, { preseasonStates = ['pre-draft', 'post-draft-preseason'] } = {}) {
    return !!snapshot && preseasonStates.includes(snapshot.takenInState);
}

// One player's preseason line out of a snapshot, or null. Null for a player the snapshot does not carry - a mid-season pickup who was not in the pool when it was taken - which is a real and common state, not an error, and the surface shows nothing rather than a zero.
export function preseasonLineFor(snapshot, playerId) {
    if (!isPreseasonSnapshot(snapshot)) return null;
    if (!snapshot.players || playerId === undefined || playerId === null) return null;
    return snapshot.players[String(playerId)] || null;
}
