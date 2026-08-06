// Roster timeline (B65/): who OWNED and who was STARTED for each player on each scoring period. PURE - no DOM, no AppState, no fetches - and league-agnostic (all sports, all league types), so it can back the Roto Race plus the Roster Time Machine and Keep/Drop counterfactuals. The impure fetch + cache lives in api.js / players.js; this file only replays already- fetched data. Two independent timelines from two sources: - OWNERSHIP (buildRosterTimeline): draft picks + executed transactions -> who rostered a player. Drives the rostered-day race and is the narrative spine B66/ read (adds/drops/trades). - STARTED (buildStartedTimeline): daily mRoster snapshots -> who had him in a STARTING slot that day. Drives the lineup-aware race, the layer ESPN's own roto standings actually count. Snapshots are used rather than the transaction LINEUP items because those items' from-slots reference proposal-time state, not the application day, so the deltas can't be reconstructed into a valid daily lineup (they drift out of the roster's slot caps); the per-day snapshot is a complete, already-valid lineup. VALIDATED SHAPES (FGB 2025 captures, - never guess ESPN's shapes, see CONVENTIONS): Draft pick: { playerId, teamId, roundId, overallPickNumber,... } from draftDetail.picks (mDraftDetail view). teamId is the drafting team = day-one owner. 110 picks = 5 teams x 22 rounds cross-checked against the DRAFT transactions below with zero mismatches. Transaction: { id, type, status, proposedDate (epoch ms), scoringPeriodId, teamId, items: [ { playerId, fromTeamId, toTeamId, type } ] }. Item membership: ADD (fromTeamId 0 -> team), DROP (team -> 0), TRADE (team -> team) all set the player's owner to the item's toTeamId - uniformly, DROP's toTeamId being 0 (unrostered). LINEUP items (from FUTURE_ROSTER, and alongside a ROSTER drop) are start/bench slot moves that do NOT change membership and are skipped here; ESPN keeps that lineup history and it is what B66/ will read to move from rostered-accurate to started-accurate. DRAFT items mirror the picks (cross-checked identical), so they are skipped too - the picks seed the roster and are authoritative. Status filter: only status === 'EXECUTED' changes rosters. The log also carries PENDING, CANCELED and FAILED_INVALIDPLAYERSOURCE entries (never happened) and exactly one status-less TRADE_ACCEPT whose items are empty (the sibling EXECUTED TRADE_ACCEPT one period later carries the real TRADE items) - all excluded, the empty one a no-op even if it slipped through.

const MEMBERSHIP_ITEM_TYPES = new Set(['ADD', 'DROP', 'TRADE']);

// The draft seed is stamped at period 0 - before any real scoring period - so a drafted player is owned from the very first day, ahead of any transaction.
const DRAFT_SEED_PERIOD = 0;

// Build the ownership timeline. Returns Map<playerId, Array<{ period, teamId }>> where each array is that player's ownership CHANGE POINTS in ascending scoring-period order (teamId 0 = unrostered). Only players who were ever drafted or transacted appear; everyone else is implicitly never rostered (teamForPlayerAtPeriod returns 0).
export function buildRosterTimeline({ picks = [], transactions = [] } = {}) {
    const changesByPlayer = new Map();
    const record = (playerId, period, teamId) => {
        if (playerId == null || teamId == null) return;
        if (!changesByPlayer.has(playerId)) changesByPlayer.set(playerId, []);
        changesByPlayer.get(playerId).push({ period, teamId });
    };

    picks.forEach(p => record(p && p.playerId, DRAFT_SEED_PERIOD, p && p.teamId));

    // Replay executed transactions in proposedDate order, since the harvested array (one request per scoring period, merged) is not guaranteed chronological across periods, and two changes to the same player within one period must apply in the order they actually happened.
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

    // Sort each player's change points by period. Array.prototype.sort is stable (ES2019+, every target browser), so same-period changes keep the proposedDate order established above - the last one in a period is the owner that period ends on.
    changesByPlayer.forEach(list => list.sort((a, b) => a.period - b.period));
    return changesByPlayer;
}

// The team that owned a player at a given scoring period (0 = unrostered, or never rostered at all). The owner is the last change point at or before `period`. Pure.
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

// STARTED timeline from the daily roster snapshots - the lineup-aware upgrade over the ownership timeline above. Where teamForPlayerAtPeriod answers "who ROSTERED this player", startedTeamForPlayerAtPeriod answers "who STARTED him" - the distinction ESPN's roto standings actually count. Every day's snapshot is a COMPLETE lineup (each team's full roster with the slot each player sat in), so unlike the transaction deltas there's nothing to carry forward or reconstruct: a player is started by a team on a period exactly when that period's snapshot has him on that team in a STARTING slot. Bench/IR days, and days he isn't rostered at all, credit nobody. `rosterDays` is { scoringPeriodId: [{ id, entries: [{ p, slot }] }] } (see harvestRosters). `startingSlots` is a Set of the league's starting lineupSlotIds - passed in already resolved so this module stays sport-agnostic (no slot catalog, no scoringItems, no sport name lives here). Returns Map<playerId, Map<period, teamId>>. Only started (player, period) pairs are present.
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

// The team that STARTED a player on an exact scoring period (0 = benched, on IR, or not rostered). A direct per-day lookup. The snapshots are complete per period, so there's no "last change at or before" walk like the ownership timeline needs. Pure.
export function startedTeamForPlayerAtPeriod(startedByPlayer, playerId, period) {
    const byPeriod = startedByPlayer.get(playerId);
    return (byPeriod && byPeriod.get(period)) || 0;
}
