/**
 * The application's state and the tables that say what ESPN's numbers mean: stat ids, lineup
 * slots and positions per sport, and which of them read better low.
 *
 * Stat ids are named from checks against real stat lines, and slots and positions from checks
 * against real player pools. An id that has not been checked is left out, so it draws no column. The numeric range an id sits in says nothing about what it means.
 *
 * The sport keys are ESPN's: flb is baseball, fhl is hockey and ffl is football.
 *
 * @module state
 */
/**
 * Twenty distinct team colours, one per team up to the league ceiling of twenty. A league past
 * that wraps. Each was chosen for contrast against both themes' surfaces and for distance from the
 * other nineteen.
 *
 * @type {string[]}
 */
export const TEAM_COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
    '#9a6324', '#b03060', '#808000', '#1b7837', '#808080', '#1f78b4',
    '#d47f00', '#6a4c93'
];

/**
 * ESPN's stat ids and their abbreviations, per sport. This is the register of ids checked against
 * real stat lines: an id is here only once a real line, or an identity that holds across a whole
 * pool, confirmed what it is. Baseball's pitch count, id 36, is the one name that rests on
 * inference, since no public line carries it to check against.
 *
 * Baseball's id 34 is innings pitched recorded as outs, so it is shown in baseball's own notation
 * and not as a decimal. The same number can mean different statistics in two sports.
 *
 * @type {Object<string, Object<number, string>>}
 */
export const ESPN_STAT_MAPS = {
    'flb': {
        0: "AB", 1: "H", 2: "AVG", 3: "2B", 4: "3B", 5: "HR", 6: "XBH",
        7: "1B", 8: "TB", 9: "SLG", 10: "BB", 11: "IBB", 12: "HBP", 13: "SF", 14: "SH",
        15: "GIDP", 16: "PA", 17: "OBP", 18: "OPS", 19: "FPTS", 20: "R", 21: "RBI",
        23: "SB", 24: "CS", 27: "K", 67: "Ch", 68: "PO", 69: "AST", 71: "FLD%", 72: "E", 73: "DP", 81: "GP",
        // Pitching. Outs, id 34, and games, id 32, are left out of this display map. Each has its own leaderboard column with baseball's own formatting.
        33: "GS", 35: "BF", 36: "PC", 37: "H", 39: "BB", 40: "IBB",
        41: "WHIP", 42: "HBP", 43: "OBP", 44: "R", 45: "ER", 46: "HR", 47: "ERA",
        48: "K", 49: "K/9", 50: "WP", 51: "BK",
        53: "W", 54: "L", 55: "W-L%", 57: "SV", 58: "BS", 59: "SV%", 62: "CG", 63: "QS", 83: "K/9"
    },
    // Hockey. Each id is anchored to identities that hold for every player in a real season's pool, such as goals plus assists equalling points, and to which positions carry it. Ids no league in the reference set scores and no identity settles are left out, and an unmapped id draws no column.
    'fhl': {
        // Skaters
        13: "G", 14: "A", 15: "+/-", 16: "PTS", 17: "PIM", 18: "PPG", 19: "PPA",
        20: "SHG", 21: "SHA", 22: "GWG", 23: "FOW", 24: "FOL", 28: "HAT", 29: "SOG",
        31: "HIT", 32: "BLK", 38: "PPP", 39: "SHP",
        // Goalies. Time on ice, in seconds, and games played are left out. Games played has its own column, and time on ice needs its own formatting.
        0: "GS", 1: "W", 2: "L", 3: "SA", 4: "GA", 6: "SV", 7: "SO", 9: "OTL", 10: "GAA", 11: "SV%"
    },
    // ==== Football ====
    'ffl': {
        // Passing
        3: "PYDS", 4: "PTD", 19: "2PTP", 20: "INT",
        // Rushing
        24: "RYDS", 25: "RTD", 26: "2PTR",
        // Receiving
        42: "REYDS", 43: "RETD", 44: "2PTRE", 53: "REC",
        // Ball security
        72: "FUML",
        // Kicking, by distance bucket. Id 85 is field goals missed, so its label must not read as field goals made. The league weights it negatively beside four positive made buckets.
        80: "FG0-39", 77: "FG40-49", 198: "FG50-59", 201: "FG60+", 85: "FGMISS", 86: "XP",
        // Team defence: the plays, then the two bracket ladders. Only the rows the log lit up.
        95: "DINT", 96: "FR", 98: "SFTY", 99: "SACK",
        89: "PA0", 91: "PA7-13", 92: "PA14-17", 123: "PA28-34",
        129: "YA100-199", 130: "YA200-299", 132: "YA350-399"
    }
};

/**
 * The spelled-out name of each abbreviation, per sport, keyed by stat id and never by
 * abbreviation, because baseball uses one short label for two different stats depending on the
 * role. An id with no entry shows its abbreviation alone.
 *
 * @type {Object<string, Object<number, string>>}
 */
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
    },
    // Football. Only the ids the football map above names.
    'ffl': {
        3: "Passing Yards", 4: "Passing Touchdowns", 19: "Two-Point Conversions Passed",
        20: "Interceptions Thrown",
        24: "Rushing Yards", 25: "Rushing Touchdowns", 26: "Two-Point Conversions Rushed",
        42: "Receiving Yards", 43: "Receiving Touchdowns",
        44: "Two-Point Conversions Received", 53: "Receptions",
        72: "Fumbles Lost",
        80: "Field Goals Made, Under 40 Yards", 77: "Field Goals Made, 40 to 49 Yards",
        198: "Field Goals Made, 50 to 59 Yards", 201: "Field Goals Made, 60 Yards or More",
        85: "Field Goals Missed", 86: "Extra Points Made",
        95: "Interceptions", 96: "Fumbles Recovered", 98: "Safeties", 99: "Sacks",
        89: "Games Allowing No Points", 91: "Games Allowing 7 to 13 Points",
        92: "Games Allowing 14 to 17 Points", 123: "Games Allowing 28 to 34 Points",
        129: "Games Allowing 100 to 199 Yards", 130: "Games Allowing 200 to 299 Yards",
        132: "Games Allowing 350 to 399 Yards"
    }
};

/**
 * Each sport's name in plain words, for a line a page shows when it has no numbers to show.
 *
 * @type {Object<string, string>}
 */
export const SPORT_NAMES = { flb: 'Baseball', fhl: 'Hockey', ffl: 'Football' };

/**
 * The stat ids club-edge.js reads off a day line, per sport. That module holds none of its own.
 * A sport with no entry has no club table.
 *
 * @type {Object<string, Object<string, string>>}
 */
export const CLUB_EDGE_STAT_IDS = {
    fhl: { played: '30', goals: '13', shots: '29', ppGoals: '18', starts: '0', wins: '1', saves: '6', shotsFaced: '3', goalsAllowed: '4' }
};

/**
 * The default position id of a football team defence. Football's roster split puts every human on
 * one side and the team defences on the other, since the two share no scored categories.
 *
 * @type {number}
 */
export const DST_POSITION_ID = 16;

/**
 * Whether a sport's categories have been validated, which every category view asks before it
 * draws a number.
 *
 * @param {string} sport The sport key.
 * @returns {boolean} True when the sport has a stat map with at least one id.
 */
export function categoriesMapped(sport) {
    const map = ESPN_STAT_MAPS[sport];
    return !!map && Object.keys(map).length > 0;
}

/**
 * The ids that read better low: a sport's own set, plus every id the league weights negatively. A
 * negative weight is the league saying lower is better, and needs no knowledge of the id.
 *
 * @param {Iterable<string>} baseInverse The sport's lower-is-better ids.
 * @param {Object<string, number>} weights The league's points per unit, by stat id.
 * @returns {Set<string>} The union.
 */
export function lowerIsBetterIds(baseInverse, weights) {
    const out = new Set(baseInverse || []);
    Object.entries(weights || {}).forEach(([id, w]) => {
        if (Number(w) < 0) out.add(String(id));
    });
    return out;
}

/**
 * The stats a sport ranks backwards, by stat id as a string. These are facts about the sport and
 * do not come from ESPN's reverse flag for a league, which was found set both ways for the same
 * stat in two leagues.
 *
 * There is no football entry. A points league's own negative weights say which of its categories
 * read better low; use leagueInverseIds, which adds them.
 *
 * @type {Object<string, Set<string>>}
 */
export const INVERSE_STATS = {
    // Caught stealing, WHIP, hit batters, runs, earned runs, home runs allowed, ERA, wild pitches, balks, losses, on-base against, blown saves and errors.
    flb: new Set(["24", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "50", "51", "54", "58", "72"]),
    // Hockey's lower-is-better stats. Only goals-against average is scored by the reference league. The others are here so any value shown or ranked reads the right way.
    fhl: new Set(["2", "4", "9", "10", "24"]) // L, GA, OTL, GAA, FOL
};
/**
 * The league's own lower-is-better set, the one expression every page reads: the sport's table
 * plus every stat the league weights negatively, in its base weights or in any slot's.
 *
 * A stat weighted positively in one place and negatively in another has no single direction, so
 * the sport's table alone decides it.
 *
 * @param {string} sport The sport key.
 * @param {?Object<string, number>} [weights] The league's base weights. Defaults to the loaded league's.
 * @param {?Object<string, Object<string, number>>} [slotWeights] The weights per lineup slot. Defaults to the loaded league's.
 * @returns {Set<string>} The stat ids that read better low.
 */
export function leagueInverseIds(sport, weights = null, slotWeights = null) {
    const base = weights || AppState.scoringWeights || {};
    const bySlot = slotWeights || AppState.scoringSlotWeights || {};
    const sign = {};
    const note = (id, w) => {
        const s = Number(w) < 0 ? -1 : (Number(w) > 0 ? 1 : 0);
        if (!s) return;
        sign[id] = (sign[id] === undefined || sign[id] === s) ? s : 0;
    };
    Object.entries(base).forEach(([id, w]) => note(String(id), w));
    Object.values(bySlot).forEach(table => Object.entries(table || {}).forEach(([id, w]) => note(String(id), w)));
    const merged = {};
    Object.keys(sign).forEach(id => { if (sign[id] < 0) merged[id] = -1; });
    return lowerIsBetterIds(INVERSE_STATS[sport], merged);
}

/**
 * Baseball's pitching stat ids. Assists and errors, 69 and 72, are fielding stats and are not
 * here, though they sit in the same numeric range.
 *
 * @type {Set<string>}
 */
export const PITCHING_IDS = new Set(["33", "34", "35", "36", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "53", "54", "55", "57", "58", "59", "62", "63", "83"]);
/**
 * Hockey's goalie-only stat ids, nonzero for goalies alone across a whole pool. They split the
 * goalies' group from the skaters'.
 *
 * @type {Set<string>}
 */
export const GOALIE_IDS = new Set(["0", "1", "2", "3", "4", "6", "7", "8", "9", "10", "11", "12"]);
/**
 * The rate and percentage stats per sport, which aggregate by averaging across weeks and never by
 * summing.
 *
 * @type {Object<string, Set<string>>}
 */
export const AVERAGE_STATS = {
    // Rates and percentages only. A counting stat here would make the drill-down chart's reference line use the season total where it should divide across weeks.
    flb: new Set(["2", "9", "17", "18", "41", "43", "47", "49", "55", "59", "83"]), // AVG, SLG, OBP, OPS, WHIP, OBP-against, ERA, K/9, W-L%, SV%, K/9
    // Hockey's two rate categories, goals-against average and save percentage. Both aggregate by averaging across weeks, since a sum of either means nothing.
    fhl: new Set(["10", "11"]) // GAA, SV%
};

/**
 * How each rate category is rebuilt from its raw components, per sport. Components are summed
 * first and the rate derived last, so a windowed total matches ESPN's season ratio; averaging
 * daily rates would weigh a light day like a heavy one.
 *
 * Each entry names the derived stat id as out, then either num, den and an optional scale for a
 * ratio, or add for a sum of rates derived earlier in the list. Entries are processed in order.
 *
 * @type {Object<string, Array<{out: string, num: (string[]|undefined), den: (string[]|undefined), scale: (number|undefined), add: (string[]|undefined)}>>}
 */
export const RATE_COMPONENTS = {
    flb: [
        { out: "2", num: ["1"], den: ["0"] },                                  // AVG = H/AB
        { out: "9", num: ["8"], den: ["0"] },                                  // SLG = TB/AB
        { out: "17", num: ["1", "10", "12"], den: ["0", "10", "12", "13"] },   // OBP = (H+BB+HBP)/(AB+BB+HBP+SF)
        { out: "18", add: ["17", "9"] },                                       // OPS = OBP + SLG
        // Pitching. Each formula reproduces ESPN's own reported value on every pitcher season line with innings in a full pool. Id 34 is outs, so innings are outs over three and the rates per nine innings carry a scale of 27.
        { out: "47", num: ["45"], den: ["34"], scale: 27 },                     // ERA = ER*9/IP
        { out: "41", num: ["37", "39"], den: ["34"], scale: 3 },                // WHIP = (H+BB)/IP
        { out: "49", num: ["48"], den: ["34"], scale: 27 },                     // K/9 = K*9/IP
        { out: "82", num: ["48"], den: ["39"] },                                // K/BB, exact on 1153 lines
        { out: "59", num: ["57"], den: ["56"] }                                 // SV% = SV/SVO, exact on 564
    ],
    fhl: [
        { out: "11", num: ["6"], den: ["3"] },                                 // SV% = SV/SA
        { out: "10", num: ["4"], den: ["8"], scale: 3600 }                     // GAA = GA * 3600 / TOI(sec)
    ]
};

/**
 * The label of each non-starting slot of a sport: the bench and the injury slot.
 *
 * @param {string} sport The sport key.
 * @returns {Object<number, string>} The label by slot id.
 */
export function nonStartingLabels(sport) {
    const ids = [...(NON_STARTING_SLOTS[sport] || new Set())].sort((a, b) => a - b);
    const catalog = LINEUP_SLOT_LABELS[sport] || {};
    const injury = sport === 'flb' ? 'IL' : 'IR';
    const out = {};
    // The slot catalog wins where it has an entry. Only a slot the catalog does not name takes the fallback: the lowest id of the pair is the bench and the other the injury slot.
    ids.forEach((id, i) => { out[id] = catalog[id] || (i === 0 ? 'BE' : injury); });
    return out;
}

/**
 * The lineup slots that do not count toward standings, per sport: the bench and the injury slot.
 * A player's daily stats credit the team only on a day the player sat outside these. The ids are
 * fixed per sport and only the counts vary by league.
 *
 * @type {Object<string, Set<number>>}
 */
export const NON_STARTING_SLOTS = {
    flb: new Set([16, 17]),
    fhl: new Set([7, 8]),
    // Football's bench and injury slots. Both take every player in the pool, so neither credits a lineup.
    ffl: new Set([20, 21])
};

/**
 * What each lineup slot is called, per sport, for a page that names a league's roster shape. It
 * is a display label; SLOT_POSITION_MAPS decodes eligibility, which is a different question. A
 * slot no league in the reference set rosters is left unnamed.
 *
 * @type {Object<string, Object<number, string>>}
 */
export const LINEUP_SLOT_LABELS = {
    flb: { 0: 'C', 1: '1B', 2: '2B', 3: '3B', 4: 'SS', 5: 'OF', 6: 'MI', 7: 'CI', 8: 'LF', 9: 'CF', 10: 'RF', 11: 'DH', 12: 'UTIL', 13: 'P', 14: 'SP', 15: 'RP', 16: 'BE', 17: 'IL', 19: 'IF' },
    // Hockey's bench and injury slots are named from the count of places: a bench holds more than an injury slot, and slot 7 holds more than slot 8 in every league seen. That both are non-starting is validated. Baseball's 16 and 17 are measured from a live league's rosters, where every injured player sat in 17 and none in 16.
    fhl: { 0: 'C', 1: 'LW', 2: 'RW', 3: 'F', 4: 'D', 5: 'G', 6: 'UTIL', 7: 'BE', 8: 'IR' },
    // Football, by crossing each slot's eligible players against their positions over a full pool. Slot 23 takes every back, receiver and tight end and no quarterback, kicker or defence, which is a flex. Slots 20 and 21 take everyone; which is the bench is read from the count of places. Slots no league in the reference set rosters are left unnamed.
    ffl: { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'BE', 21: 'IR', 23: 'FLEX' }
};

/**
 * The starting slots that belong to a sport's second group: baseball's pitching slots, hockey's
 * goalie slot and football's team-defence slot. Every other starting slot is primary. A flex slot
 * in this set is measured against the second group's pool.
 *
 * @type {Object<string, Set<number>>}
 */
export const SECONDARY_LINEUP_SLOTS = {
    flb: new Set([13, 14, 15]),
    fhl: new Set([5]),
    // Football's second group is the team defences, and slot 16 is the only place one can start.
    ffl: new Set([16])
};

/**
 * The order a roster reads in, top to bottom, per sport: the position slots in ESPN's own order,
 * then the flex slots. A rostered slot missing from the list is appended in id order.
 *
 * @type {Object<string, number[]>}
 */
export const LINEUP_SLOT_ORDER = {
    flb: [0, 1, 2, 3, 4, 6, 7, 19, 5, 12, 13, 14, 15],
    // Football, in the order a lineup card reads: the named positions, then the flex, then the two specialist slots.
    ffl: [0, 2, 4, 6, 23, 17, 16],
    // Centre, left wing and right wing come first, then the flex slots, so a league that starts centres lists them ahead of the utility slot.
    fhl: [0, 1, 2, 3, 4, 5, 6]
};

/**
 * A fixed display order for stat ids whose numeric order misleads. Football's kicking buckets
 * were not numbered in order of distance. Ids outside a sport's list keep their numeric order.
 *
 * @type {Object<string, string[]>}
 */
export const STAT_DISPLAY_ORDER = {
    ffl: ["80", "77", "198", "201", "85", "86"]
};

/**
 * Position names by a player's default position id, per sport.
 *
 * @type {Object<string, Object<number, string>>}
 */
export const POSITION_MAPS = {
    flb: { 0: "P", 1: "SP", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH", 11: "RP" },
    fhl: { 1: "C", 2: "LW", 3: "RW", 4: "D", 5: "G" },
    // Football. Two positions appear on one player each, in a league that rosters neither. One player is not evidence for a position's name, so both are left out.
    ffl: { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" }
};

/**
 * The flex seats per sport. A flex seat takes whoever is left over, so it is not a position a
 * roster can be short at.
 *
 * @type {Object<string, Set<number>>}
 */
export const FLEX_SLOTS = {
    flb: new Set([6, 7, 12, 13, 19]),   // MI, CI, UTIL, P, IF
    fhl: new Set([3, 6]),               // F, UTIL
    ffl: new Set([23])                  // FLEX
};

/**
 * Which positions each flex seat accepts, per sport, measured from the eligible slots of every
 * player in a pool. A position is listed only when every player of it is eligible at the seat. A
 * sport with no entry has not been measured.
 *
 * @type {Object<string, Object<number, Set<string>>>}
 */
export const FLEX_SLOT_POSITIONS = {
    // Baseball, by a completeness test: a position belongs to a flex slot only when every player of that position is eligible there, so one cross-eligible player never brings a whole position in. Middle infield is second and short, corner infield is first and third, the infield is those four, utility is every batter and P is every pitcher.
    flb: {
        6: new Set(["2B", "SS"]),
        7: new Set(["1B", "3B"]),
        12: new Set(["C", "1B", "2B", "3B", "SS", "OF", "DH"]),
        13: new Set(["SP", "RP"]),
        19: new Set(["1B", "2B", "3B", "SS"])
    },
    // Hockey. Slot 3 accepts every forward and no defenceman or goalie, which makes it the forward seat. Slot 6 accepts every skater and no goalie, which makes it utility.
    fhl: {
        3: new Set(["C", "LW", "RW"]),
        6: new Set(["C", "LW", "RW", "D"])
    },
    ffl: {
        3: new Set(["RB", "WR"]),
        5: new Set(["TE", "WR"]),
        7: new Set(["QB", "RB", "TE", "WR"]),
        23: new Set(["RB", "TE", "WR"])
    }
};

/**
 * Position names by lineup slot id, per sport, for decoding a player's eligible slots. Slot ids
 * are a different numbering from default position ids. Slots that are not a position, such as the
 * bench and the flex seats, have no entry.
 *
 * @type {Object<string, Object<number, string>>}
 */
export const SLOT_POSITION_MAPS = {
    flb: { 0: "C", 1: "1B", 2: "2B", 3: "3B", 4: "SS", 5: "OF", 8: "LF", 9: "CF", 10: "RF", 11: "DH", 13: "P", 14: "SP", 15: "RP" },
    ffl: { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K" },
    // Hockey. A slot that accepts every player of one default position, and beyond them only a few players eligible at two, is that position's slot. Without this entry a winger who is also eligible at centre would show one position. Slots 3 and 6 are flex seats and are listed with the flex seats.
    fhl: { 0: "C", 1: "LW", 2: "RW", 4: "D", 5: "G" }
};

/**
 * The positions that form a sport's second ranking pool: baseball's pitchers, hockey's goalies and
 * football's team defences.
 *
 * @type {Object<string, Set<string>>}
 */
export const SECONDARY_GROUP_POSITIONS = {
    flb: new Set(["P", "SP", "RP"]),
    fhl: new Set(["G"]),
    ffl: new Set(["D/ST"])
};

/**
 * The application's one shared state: the loaded league, what was derived from it, and every
 * view's current selections.
 *
 * @type {object}
 */
export const AppState = {
    visibleTeams: new Set(),
    apiData: null,
    teamStats: [],
    teamColorMap: {},
    // The reader's own names for teams, kept in this browser only and keyed by team id as a string. Loaded per league and cleared on every league switch. League History keys its own lookup by franchise, since a team id is not stable across seasons.
    nicknames: new Map(),
    availableStatsSet: new Set(),
    // The sport of the league that is loaded, set from the payload's own game id. Every view of loaded data reads its maps from here and never from the sport dropdown, which is an input for the next fetch.
    loadedSport: 'flb',
    isPointsLeague: false,
    // Season-long roto: standings build over the whole season with no weekly matchups, so the matchup-based views do not apply. Set in data.js.
    isRotoLeague: false,
    leagueHistoryYears: [],
    maxCompletedWeek: 1,
    regSeasonWeeks: 16,
    // Whether the season has finished, from the payload's own status. It is not the same as the last completed matchup, which mid-season only says how far the season has got.
    isSeasonOver: false,
    // The matchup being played now. 0 when the season is over or unknown.
    currentMatchup: 0,
    // Points per unit by stat id, from the league's own scoring settings. Used by a points league only, where the weighted stat line is the player's fantasy total. Empty for category and roto leagues.
    scoringWeights: {},
    // Points by stat id per lineup slot, for a league whose scoring differs by slot. Football's team-defence ids score only here.
    scoringSlotWeights: {},
    // The coverage drawer's mode and, in pick mode, the ids the reader picked. Held for the session only: a mode is a question being asked now, not a preference.
    coverageAddsMode: 'one',
    coverageAddsPicked: new Set(),
    // The scored ids that belong to the secondary group, derived from the league's own scoring: an id scored only in a secondary slot. Empty for a league whose scoring does not vary by slot.
    secondaryStatIds: new Set(),
    // The Category Heatmap's column sort: the stat id the rows are ordered by, or null for the default team order. Held here so the inline band and the pop-out share it.
    heatmapSortCat: null,
    heatmapSortDir: 'desc',
    // The draft picks and executed transactions of the current league, harvested once a session. Null before the harvest and after one that found nothing. The key stops one league's log being served for another.
    rosterTransactionData: null,
    // The league's daily roster snapshots, harvested once a session. Each day carries every team's roster with the slot each player sat in that day, the only source that says who was started. Null before the harvest and after one that found nothing, and keyed like the log above.
    rosterSnapshotData: null,
    championTeamId: null,
    scoredStatIds: new Set(),
    leagueActiveSlots: new Set(),
    // The logged-in reader's ESPN id, from the cookie. It picks out the reader's own team. Empty when unknown.
    userSwid: '',

    // The one shared timeframe. It drives Team Metrics, the Player Metrics leaderboard and the player drill-down together.
    timeframe: 'all',

    // Which face the Rankings box shows: 'standings' for Team Rankings or 'category' for Category Rankings.
    rankingsBoxView: 'standings',

    playerData: [],
    playerDataLoaded: false,
    // Why the player pool is missing, when it is. The league payload can load without a login while the pool cannot, so several tabs have to explain it. Null means nothing failed.
    playerDataError: null,
    // The same for the league payload, set only when the login is the reason, since that is the only failure logging in fixes.
    leagueDataError: null,
    // The pro schedule for the loaded sport and season, keyed so a switch to another sport or year fetches again.
    proTeamSchedules: null,
    // The day's scoreboard, where the betting lines are. Keyed by sport and hour and never stored, since a line moves during the day and a stale price is worse than none.
    scoreboardOdds: null,
    // Betting lines are opt-in and off by default. While this is false the scoreboard is not fetched at all.
    showBettingOdds: false,
    playerSortStat: 'rotoScore',
    playerSortDir: 'desc',
    playerSearchQuery: '',
    playerPositionFilter: 'ALL',
    // The leaderboard's availability filter: 'all', 'rostered' for players on a fantasy team, or 'fa' for free agents.
    playerAvailabilityFilter: 'all',
    // Which single team the leaderboard is narrowed to. The kind is 'all', 'fantasy' with a fantasy team id, or 'pro' with a pro team id. Reset whenever the availability filter changes, since the set of teams on offer changes with it.
    playerBreakoutFilter: { kind: 'all', id: null },
    playerGroup: 'primary',
    showAdvancedStats: false,
    requireMinPlayingTime: true,
    selectedPlayerId: null,
    playerDetailStat: null,
    playerDetailRankPool: 'Overall',
    // The leaderboard's pick-to-compare group, in pick order with the anchor first. It survives a search or a filter change and is reset only on a league switch. A comparison of two players is this group at length one.
    playerCompareGroupIds: [],
    playerDetailRankBreakdownOpen: false,
    // Which side of the rank breakdown's Overall and Matchup switch is lit. Read only where the panel offers the switch.
    playerDetailMatchupSide: 'overall',
    // My Team's opponent for the comparison. Cleared on a league switch. Null means no comparison is shown.
    myTeamCompareOpponentId: null,
    // Whether the comparison drawer is open. Closing it keeps the opponent.
    myTeamCompareDrawerOpen: false,
    // Whether the coverage drawer is open, held here so the toggle's label survives a re-render.
    myTeamCoverageDrawerOpen: false,
    // The first period of the pitchers' calendar window, which pages seven days at a time through a longer matchup. Null means not pinned: open on the window that holds today, worked out on each render.
    myTeamScheduleWindowStart: null,
    // Whether the compare band's day strip is open. Baseball only, and closed by default.
    myTeamCompareStripOpen: false,
    // The strip's week page, a week index from one into the matchup and not a period number, so pages never overlap. Null means open on the week that holds today.
    myTeamCompareWeekIndex: null,
    playerWeeklyCache: {},
    // The one shared forward look: null, 'next' or 'rest'. It drives the leaderboard's window column and My Team's comparison and coverage. Cleared on every fresh league fetch, since it belongs to this league's matchups.
    ahead: null,
    // The Empty Nights column, a toggle of its own beside the forward look. It covers the current matchup only.
    showEmptyNights: false,
    // The mock lineup, in mock-lineup.js's own state shape. Built on the first pre-draft render, since it needs the league's slot counts, and reset on every league switch.
    mockLineupState: null,
    // The seat armed to receive the next row click, as an index into the mock lineup's seats, or null.
    mockLineupTarget: null,
    // Which position chip is lit above the mock Projections list. Reset with the mock lineup.
    mockPoolPositionFilter: 'ALL',
    // The search typed above the mock Projections list. Reset with the position chip.
    mockPoolSearchQuery: ''
};
