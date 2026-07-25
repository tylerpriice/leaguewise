// Ownership and started timelines per scoring period, built from draft picks, executed transactions and daily roster snapshots. Pure: no DOM, no AppState, no fetches.

// LINEUP items are start/bench slot moves and DRAFT items mirror the picks, so neither changes membership.
const MEMBERSHIP_ITEM_TYPES = new Set(['ADD', 'DROP', 'TRADE']);

// The draft seed sits at period 0, before any real scoring period, so a drafted player is owned from day one.
const DRAFT_SEED_PERIOD = 0;

// Returns Map<playerId, [{ period, teamId }]> of ownership change points in ascending period order (teamId 0 = unrostered).
export function buildRosterTimeline({ picks = [], transactions = [] } = {}) {
    const changesByPlayer = new Map();
    const record = (playerId, period, teamId) => {
        if (playerId == null || teamId == null) return;
        if (!changesByPlayer.has(playerId)) changesByPlayer.set(playerId, []);
        changesByPlayer.get(playerId).push({ period, teamId });
    };

    picks.forEach(p => record(p && p.playerId, DRAFT_SEED_PERIOD, p && p.teamId));

    // Only EXECUTED transactions change rosters, and they replay in proposedDate order because the harvested array is not chronological across periods.
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

    // Array.prototype.sort is stable, so same-period changes keep proposedDate order and the last one owns the period.
    changesByPlayer.forEach(list => list.sort((a, b) => a.period - b.period));
    return changesByPlayer;
}

// The owner at a period is the last change point at or before it.
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

// A player counts as started for a team on a period when that period's snapshot has him in a starting slot. Returns Map<playerId, Map<period, teamId>>, started pairs only.
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

// Snapshots are complete per period, so this is a direct lookup rather than a walk backwards.
export function startedTeamForPlayerAtPeriod(startedByPlayer, playerId, period) {
    const byPeriod = startedByPlayer.get(playerId);
    return (byPeriod && byPeriod.get(period)) || 0;
}
