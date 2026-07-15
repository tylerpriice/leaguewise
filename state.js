export const TEAM_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff'];

// ESPN's stat ids are undocumented.
export const ESPN_STAT_MAPS = {
    'flb': {
        0: "AB", 1: "H", 2: "AVG", 3: "2B", 4: "3B", 5: "HR", 6: "XBH",
        7: "1B", 8: "TB", 9: "SLG", 10: "BB", 11: "IBB", 12: "HBP", 13: "SF", 14: "SH",
        15: "GIDP", 16: "PA", 17: "OBP", 18: "OPS", 19: "FPTS", 20: "R", 21: "RBI",
        23: "SB", 24: "CS", 27: "K", 67: "Ch", 68: "PO", 69: "AST", 71: "FLD%", 72: "E", 73: "DP", 81: "GP",
        // 34 (Outs/IP) and 32 (G) are intentionally left out. Both get their own dedicated leaderboard column with real baseball formatting instead of the generic stat cell.
        33: "GS", 35: "BF", 36: "PC", 37: "H", 39: "BB", 40: "IBB",
        41: "WHIP", 42: "HBP", 43: "OBP", 44: "R", 45: "ER", 46: "HR", 47: "ERA",
        48: "K", 49: "K/9", 50: "WP", 51: "BK",
        53: "W", 54: "L", 55: "W-L%", 57: "SV", 58: "BS", 59: "SV%", 62: "CG", 63: "QS", 83: "K/9"
    },
    'fhl': {
        1: "G", 2: "A", 3: "PTS", 4: "+/-", 5: "PIM", 8: "PPG", 9: "PPA", 10: "PPP",
        11: "SHG", 12: "SHA", 13: "SHP", 14: "GWG", 15: "FOW", 16: "FOL", 29: "SOG",
        31: "HIT", 32: "BLK", 35: "W", 36: "L", 37: "OTL", 38: "GAA", 39: "SV",
        40: "SA", 41: "SV%", 42: "SHO"
    }
};

// Based on real baseball/hockey facts (fewer errors, fewer times caught stealing, a lower ERA are always better). NOT on ESPN's per-league isReverseItem flag.
export const INVERSE_STATS = {
    flb: new Set(["24", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "50", "51", "54", "58", "72"]),
    fhl: new Set(["36", "38"]) // L, GAA
};
// 69 (AST) and 72 (E) are fielding stats, not pitching, despite numerically sitting in this range. Excluded here so they sort into the batter group instead of the pitcher one.
export const PITCHING_IDS = new Set(["33", "34", "35", "36", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "53", "54", "55", "57", "58", "59", "62", "63", "83"]);
export const GOALIE_IDS = new Set(["35", "36", "37", "38", "39", "40", "41", "42"]);
export const AVERAGE_STATS = {
    // Rate/percentage stats only. A counting stat here would make the drill-down chart's reference line use the season TOTAL directly instead of dividing across weeks.
    flb: new Set(["2", "9", "17", "18", "41", "43", "47", "49", "55", "59", "83"]), // AVG, SLG, OBP, OPS, WHIP, OBP-against, ERA, K/9, W-L%, SV%, K/9
    fhl: new Set(["38", "41"]) // GAA, SV%
};

export const POSITION_MAPS = {
    flb: { 0: "P", 1: "SP", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH", 11: "RP" },
    fhl: { 1: "C", 2: "LW", 3: "RW", 4: "D", 5: "G" }
};

// eligibleSlots uses ESPN's roster-slot id catalog. A different numbering scheme from defaultPositionId above.
export const SLOT_POSITION_MAPS = {
    flb: { 0: "C", 1: "1B", 2: "2B", 3: "3B", 4: "SS", 5: "OF", 8: "LF", 9: "CF", 10: "RF", 11: "DH", 13: "P", 14: "SP", 15: "RP" }
};

export const PITCHER_POSITIONS = {
    flb: new Set(["P", "SP", "RP"]),
    fhl: new Set(["G"])
};

// Central Application Memory
export const AppState = {
    visibleTeams: new Set(),
    apiData: null,
    teamStats: [],
    teamColorMap: {},
    availableStatsSet: new Set(),
    isPointsLeague: false,
    leagueHistoryYears: [],
    maxCompletedWeek: 1,
    regSeasonWeeks: 16,
    championTeamId: null,
    scoredStatIds: new Set(),
    leagueActiveSlots: new Set(),
    // The logged-in user's SWID (from the ESPN cookie). Used to auto-detect "my team" for the weekly recap by matching against each team's primaryOwner/owners.
    userSwid: '',

    // The ONE shared timeframe selection. Drives Team Metrics graphs, the Player Metrics leaderboard's ranks/stats, and the player drill-down chart, all at once.
    timeframe: 'all',

    // The Rankings box (Team Metrics) switches between standings bars/pies ('standings') and Category Rankings + its picker ('category') via the box's header tabs.
    rankingsBoxView: 'standings',

    playerData: [],
    playerDataLoaded: false,
    playerSortStat: 'total',
    playerSortDir: 'desc',
    playerSearchQuery: '',
    playerPositionFilter: 'ALL',
    // 'all' / 'rostered' / 'fa'. A display-only filter, never rescopes the rank pool.
    playerAvailabilityFilter: 'all',
    playerGroup: 'primary',
    showAdvancedStats: false,
    requireMinPlayingTime: true,
    selectedPlayerId: null,
    playerDetailStat: null,
    playerDetailRankPool: 'Overall',
    playerDetailRankBreakdownOpen: false,
    playerWeeklyCache: {}
};
