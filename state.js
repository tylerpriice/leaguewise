// Twenty distinct team colours, because leagues go to 20 and the map wraps. The added ones are measured, not assumed: each clears a contrast check against BOTH theme surfaces and an RGB-distance check against every other colour, which several stock palette entries fail.
export const TEAM_COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
    '#9a6324', '#b03060', '#808000', '#1b7837', '#808080', '#1f78b4',
    '#d47f00', '#6a4c93'
];

// Never guess an ESPN stat id. Every id here was confirmed against real published stat lines, and numeric range is no signal for meaning: 69 and 72 are fielding stats sitting inside the pitching range, 34 is innings pitched recorded AS OUTS, and 83 is a second distinct id that also means K/9.
export const ESPN_STAT_MAPS = {
    'flb': {
        0: "AB", 1: "H", 2: "AVG", 3: "2B", 4: "3B", 5: "HR", 6: "XBH",
        7: "1B", 8: "TB", 9: "SLG", 10: "BB", 11: "IBB", 12: "HBP", 13: "SF", 14: "SH",
        15: "GIDP", 16: "PA", 17: "OBP", 18: "OPS", 19: "FPTS", 20: "R", 21: "RBI",
        23: "SB", 24: "CS", 27: "K", 67: "Ch", 68: "PO", 69: "AST", 71: "FLD%", 72: "E", 73: "DP", 81: "GP",
        // Pitching. 34 (Outs/IP) and 32 (G) are left out on purpose, since both get a dedicated leaderboard column with real baseball formatting instead of the generic stat cell.
        33: "GS", 35: "BF", 36: "PC", 37: "H", 39: "BB", 40: "IBB",
        41: "WHIP", 42: "HBP", 43: "OBP", 44: "R", 45: "ER", 46: "HR", 47: "ERA",
        48: "K", 49: "K/9", 50: "WP", 51: "BK",
        53: "W", 54: "L", 55: "W-L%", 57: "SV", 58: "BS", 59: "SV%", 62: "CG", 63: "QS", 83: "K/9"
    },
    // Hockey ids are anchored to league-wide identities that hold for every player, not to one stat line: 13+14==16 for G/A/PTS, 3-4==6 for SA/GA/SV, 18+19==38 and 20+21==39 for the power-play and shorthanded pairs. Ids that could not be validated are left out rather than guessed, and an unmapped id renders no column.
    'fhl': {
        // Skaters
        13: "G", 14: "A", 15: "+/-", 16: "PTS", 17: "PIM", 18: "PPG", 19: "PPA",
        20: "SHG", 21: "SHA", 22: "GWG", 23: "FOW", 24: "FOL", 28: "HAT", 29: "SOG",
        31: "HIT", 32: "BLK", 38: "PPP", 39: "SHP",
        // Goalies. Time on ice in seconds and GP are omitted, since GP has its own leaderboard column and raw seconds need their own formatting.
        0: "GS", 1: "W", 2: "L", 3: "SA", 4: "GA", 6: "SV", 7: "SO", 9: "OTL", 10: "GAA", 11: "SV%"
    }
};

// Spelled-out names keyed by STAT ID per sport, never by abbreviation, because baseball reuses one short label for different stats by role (1 and 37 are both "H", 10 and 39 both "BB", 20 and 44 both "R"). An id with no entry here shows its abbreviation alone.
export const ESPN_STAT_FULL_NAMES = {
    'flb': {
        // Batting
        0: "At Bats", 1: "Hits", 2: "Batting Average", 3: "Doubles", 4: "Triples", 5: "Home Runs",
        6: "Extra Base Hits", 7: "Singles", 8: "Total Bases", 9: "Slugging Percentage", 10: "Walks",
        11: "Intentional Walks", 12: "Hit By Pitch", 13: "Sacrifice Flies", 14: "Sacrifice Hits",
        15: "Grounded Into Double Play", 16: "Plate Appearances", 17: "On Base Percentage",
        18: "On Base Plus Slugging", 19: "Fantasy Points", 20: "Runs", 21: "Runs Batted In",
        23: "Stolen Bases", 24: "Caught Stealing", 27: "Strikeouts",
        // Fielding
        67: "Chances", 68: "Putouts", 69: "Assists", 71: "Fielding Percentage", 72: "Errors",
        73: "Double Plays", 81: "Games Played",
        // Pitching. The "allowed" wording is what keeps these distinct from their batting twins.
        33: "Games Started", 35: "Batters Faced", 36: "Pitch Count", 37: "Hits Allowed",
        39: "Walks Allowed", 40: "Intentional Walks Allowed",
        41: "Walks Plus Hits Per Inning Pitched", 42: "Hit Batters",
        43: "On Base Percentage Against", 44: "Runs Allowed", 45: "Earned Runs",
        46: "Home Runs Allowed", 47: "Earned Run Average", 48: "Strikeouts",
        49: "Strikeouts Per Nine Innings", 50: "Wild Pitches", 51: "Balks", 53: "Wins", 54: "Losses",
        55: "Win Loss Percentage", 57: "Saves", 58: "Blown Saves", 59: "Save Percentage",
        62: "Complete Games", 63: "Quality Starts", 83: "Strikeouts Per Nine Innings"
    },
    'fhl': {
        // Skaters
        13: "Goals", 14: "Assists", 15: "Plus Minus", 16: "Points", 17: "Penalty Minutes",
        18: "Power Play Goals", 19: "Power Play Assists", 20: "Short Handed Goals",
        21: "Short Handed Assists", 22: "Game Winning Goals", 23: "Faceoffs Won",
        24: "Faceoffs Lost", 28: "Hat Tricks", 29: "Shots On Goal", 31: "Hits",
        32: "Blocked Shots", 38: "Power Play Points", 39: "Short Handed Points",
        // Goalies
        0: "Games Started", 1: "Wins", 2: "Losses", 3: "Shots Against", 4: "Goals Against",
        6: "Saves", 7: "Shutouts", 9: "Overtime Losses", 10: "Goals Against Average",
        11: "Save Percentage"
    }
};

// Based on real baseball and hockey facts (fewer errors and a lower ERA are always better), NOT on ESPN's per-league isReverseItem flag, which came back inconsistent for the same stat between two real leagues. Do not trust it as a signal for which direction is better.
export const INVERSE_STATS = {
    // CS, WHIP, HBP, R, ER, HR, ERA, WP, BK, L, OBP against, BS, E.
    flb: new Set(["24", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "50", "51", "54", "58", "72"]),
    // Lower-is-better hockey stats. Only GAA is scored by the reference league, and the rest are inverse facts included so any displayed or ranked value reads correctly.
    fhl: new Set(["2", "4", "9", "10", "24"]) // L, GA, OTL, GAA, FOL
};
// 69 (AST) and 72 (E) are fielding stats, not pitching, despite sitting in this numeric range. Excluded here so they sort into the batter group instead of the pitcher one.
export const PITCHING_IDS = new Set(["33", "34", "35", "36", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "53", "54", "55", "57", "58", "59", "62", "63", "83"]);
// Goalie-only ids, nonzero for defaultPositionId 5 alone. Hockey's analogue to PITCHING_IDS, splitting Goalies from Skaters wherever the code asks whether a stat belongs to the secondary role.
export const GOALIE_IDS = new Set(["0", "1", "2", "3", "4", "6", "7", "8", "9", "10", "11", "12"]);
export const AVERAGE_STATS = {
    // Rate and percentage stats only. A counting stat here would make the drill-down chart's reference line use the season total directly instead of dividing it across weeks.
    flb: new Set(["2", "9", "17", "18", "41", "43", "47", "49", "55", "59", "83"]), // AVG, SLG, OBP, OPS, WHIP, OBP-against, ERA, K/9, W-L%, SV%, K/9
    // The two hockey rate categories, 10 (GAA) and 11 (SV%). Both must aggregate by averaging across weeks rather than summing, or a 2.50 GAA would sum past 40 over a season.
    fhl: new Set(["10", "11"]) // GAA, SV%
};

// Rate categories are reproduced from their raw COMPONENT stats rather than from the already-computed daily rate, because ESPN's season value for a rate is the whole-season ratio and averaging each day's rate weights a 1-shot night like a 40-shot one. Each entry is { num, den, scale } for a ratio or { add } to sum earlier overrides, processed in array order. Pitching rates stay out until a fixture exists to confirm them.
export const RATE_COMPONENTS = {
    flb: [
        { out: "2", num: ["1"], den: ["0"] },                                  // AVG = H/AB
        { out: "9", num: ["8"], den: ["0"] },                                  // SLG = TB/AB
        { out: "17", num: ["1", "10", "12"], den: ["0", "10", "12", "13"] },   // OBP = (H+BB+HBP)/(AB+BB+HBP+SF)
        { out: "18", add: ["17", "9"] }                                        // OPS = OBP + SLG
    ],
    fhl: [
        { out: "11", num: ["6"], den: ["3"] },                                 // SV% = SV/SA
        { out: "10", num: ["4"], den: ["8"], scale: 3600 }                     // GAA = GA * 3600 / TOI(sec)
    ]
};

// Roster slots that do NOT count toward standings: bench and injured reserve. A player's daily stats credit his team only when that day's lineupSlotId is outside this set, and the starting set is derived per league from lineupSlotCounts minus these. Confirmed for baseball against a real in-progress capture of four teams' lineups, where every starting slot fills to exactly its cap and 16 and 17 are the only slots every rostered player is eligible for, which is the signature of bench and IL.
export const NON_STARTING_SLOTS = {
    flb: new Set([16, 17]),
    fhl: new Set([7, 8])
};

// The order a roster reads in, top to bottom, per sport: position slots first in ESPN's own catalog order, then the flex and utility slots, then the generic ones, which is the order the fantasy site itself lists a lineup in. Validated from the same capture as NON_STARTING_SLOTS, with decisive per-slot evidence, and catalog slots a league does not roster are ordered on the slot-map reading until one shows up. Any slot a league rosters that is missing here still renders, appended in id order.
export const LINEUP_SLOT_ORDER = {
    flb: [0, 1, 2, 3, 4, 6, 7, 19, 5, 12, 13, 14, 15],
    fhl: [3, 4, 5, 6]
};

export const POSITION_MAPS = {
    flb: { 0: "P", 1: "SP", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH", 11: "RP" },
    fhl: { 1: "C", 2: "LW", 3: "RW", 4: "D", 5: "G" }
};

// eligibleSlots uses ESPN's roster-slot catalog, a different numbering scheme from defaultPositionId above, confirmed against the real eligibility of five different players. Outfield granularity follows the league's own active slots, while every other slot shows whenever a player is eligible, since eligibility describes the player rather than the league's roster construction.
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
    // The sport of the league currently LOADED, set from the payload's own gameId. Every view of loaded data reads its stat maps, position maps and role groups from here and never from the sport dropdown, which is an input for the next fetch: a user browsing it re-rendered the loaded pool under the other sport's rules.
    loadedSport: 'flb',
    isPointsLeague: false,
    // Season-long roto accumulates with no weekly matchups, so the matchup-based Team Metrics pipeline has nothing to stand on and shows a notice instead. Player Metrics is matchup-agnostic and still works, so this flag gates only the one tab.
    isRotoLeague: false,
    leagueHistoryYears: [],
    maxCompletedWeek: 1,
    regSeasonWeeks: 16,
    // Whether the season has actually finished, derived from the payload's own schedule status. Distinct from maxCompletedWeek, which mid-season only means the last completed matchup.
    isSeasonOver: false,
    // The matchup being played right now, which is one past maxCompletedWeek on the morning before its first game. Zero when the season is over or unknown.
    currentMatchup: 0,
    // statId to points per unit, from the league's own scoringSettings. Only a points league uses it, where the weighted stat line is the player's fantasy total. Empty for category and roto leagues.
    scoringWeights: {},
    // The heatmap column the rows are sorted by, or null for the default team order. It lives here so the state carries between the inline band and the pop-out, which share one renderer.
    heatmapSortCat: null,
    heatmapSortDir: 'desc',
    // Draft picks and the executed transaction log, harvested once per session. Key-guarded so a previous league's log is never served, and null when the harvest fails or finds nothing.
    rosterTransactionData: null,
    // The league's daily roster snapshots, the only source that says who was STARTED rather than merely rostered. Key-guarded too, and null when the harvest fails, in which case the race falls back to the transaction timeline and then to current rosters.
    rosterSnapshotData: null,
    championTeamId: null,
    scoredStatIds: new Set(),
    leagueActiveSlots: new Set(),
    // The logged-in user's SWID from the ESPN cookie, used to auto-detect their own team for the recap by matching each team's owners. Empty when unknown.
    userSwid: '',

    // The one shared timeframe selection, driving the Team Metrics graphs, the leaderboard's ranks and stats, and the drill-down chart together.
    timeframe: 'all',

    // The Rankings box switches between the standings bars and Category Rankings through its header tabs.
    rankingsBoxView: 'standings',

    playerData: [],
    playerDataLoaded: false,
    playerSortStat: 'rotoScore',
    playerSortDir: 'desc',
    playerSearchQuery: '',
    playerPositionFilter: 'ALL',
    // Roster availability filter for the leaderboard: 'all', 'rostered' or 'fa'. Availability comes from a player's teamId.
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
