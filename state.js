// TWENTY distinct team colours, because leagues go to 20 and the map wraps. At 12 entries a 20-team league gave eight teams a colour another team already had, and the two-column standings put some of those duplicates side by side, reported on a 20-team league. The count is the league ceiling, not a guess - a 21st team would wrap again, which is why this list is exactly 20. The first twelve are unchanged, deliberately. They are the first twelve of the well-known maximally-distinct qualitative palette this list has always used, and rewriting them would recolour every existing league, its recap images, and its legend for no reason. The eight added are MEASURED, not taken on faith. That palette's own remaining entries could not be used as-is. Three (beige, mint, apricot) sit near 0.9 luminance and vanish on the light theme's #f1f3f5 surface, and its maroon #800000 and navy #000075 are the mirror image of the same fault - contrast 1.20 and 1.28 against the dark theme's #273142, which is effectively invisible. Each replacement was picked by computing its contrast against BOTH theme surfaces and its RGB distance from all nineteen others. Every added colour clears 2.0 on both themes except #6a4c93 at 1.91 on dark, which is no worse than the #911eb4 that already ships at 1.90; the closest pair in the whole set is brown vs olive at 53 RGB units apart.
export const TEAM_COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
    '#9a6324', '#b03060', '#808000', '#1b7837', '#808080', '#1f78b4',
    '#d47f00', '#6a4c93'
];

// Batting (0-27, 81) confirmed correct via two independent real diagnostic dumps: 2025 Jose Ramirez, and a 2026 Otto Lopez dump whose derived stats (AVG, XBH, 1B, TB, SLG, OBP, PA, OPS) all recompute exactly from these ids using standard formulas. Fielding ids 67, 68, 69, 71, 72, 73 (Ch, PO, AST, FLD%, E, DP) are CONFIRMED against Otto Lopez's real 2026 Baseball-Reference fielding line - exact matches, including FLD% recomputed from PO/A/Ch. Important correction. 69 and 72 are NOT pitching stats despite sitting in that numeric range - they're Assists and Errors. A previous pass wrongly assumed the whole 33-83 range was pitching-only and had 69/72 labeled "K"/"QS", which a real league's scoringItems dump seemed to "confirm" only because those ids genuinely are scored - just not for what we thought. The lesson is that numeric range is not a reliable signal for what a stat id means. Pitching ids 48 (K), 53 (W), 57 (SV), 63 (QS) are CONFIRMED against Cristopher Sanchez's real 2026 stat line (137 K, 10 W, 0 SV, 13 QS) - all exact matches. 47 (ERA), 41 (WHIP), and 49 (K/9) are CONFIRMED against Logan Webb's real 2025 stat line (3.22 ERA, 1.237 WHIP, 9.7 K/9) - also exact matches, and 41/47's isReverseItem:true in a real scoringItems dump lines up perfectly (WHIP and ERA are the only "lower is better" stats here). 49 was previously (wrongly) labeled "HR" - that's what caused a real HR column to incorrectly appear under Pitchers for a league that actually scores K/9. 83 is a SECOND, distinct ESPN stat id that also means K/9 (seen alongside 49 in real scoringItems dumps, never both at once) - mapped to the same "K/9" label/AVERAGE_STATS treatment as 49 rather than being a typo or duplicate bug. The rest of the pitching range (33, 35, 37, 39, 40, 42, 43, 44, 46, 50, 51, 54, 55, 58, 59, 62) is CONFIRMED via exact-match validation against three real 2025 season stat lines - Tarik Skubal (a 195.1 IP workhorse starter), Aroldis Chapman (a 61.1 IP one-inning closer), and Garrett Whitlock (a 72.0 IP multi-inning reliever), chosen specifically to span very different pitcher workload shapes. Every value below recomputes exactly against Baseball-Reference's real 2025 lines for all three. This correction replaced several ids that were actively wrong, not just unlabeled - e.g. 42 was labeled "BS" but is really HBP (so a league scoring "blown saves" would have shown Skubal, a starter, with "5 blown saves"), 44 was a duplicate "ERA" that's really R allowed, and 33/50 were both wrongly labeled things that collided with the real BB id (39), silently hiding whichever the dedup logic picked. 34 ("Outs") is the one that mattered most. It is real innings pitched recorded AS OUTS (not id 46, which was wrongly assumed to be IP before this validation - 46 is actually HR allowed). outs/3 = true IP, but display it with formatInnings() (see players.js) using baseball's real fractional notation (.1 = one out into the inning,.2 = two outs) - a naive decimal divide renders wrong (586 outs is 195.1 IP, not 195.333). 36 ("PC", pitches thrown) is a strong but not exactly-confirmed inference - Baseball-Reference doesn't publish pitch counts, but 36/BF lands at a consistent ~3.8-4.0 pitches/batter across all three very different pitchers, which is the expected real-world range.
export const ESPN_STAT_MAPS = {
    'flb': {
        0: "AB", 1: "H", 2: "AVG", 3: "2B", 4: "3B", 5: "HR", 6: "XBH",
        7: "1B", 8: "TB", 9: "SLG", 10: "BB", 11: "IBB", 12: "HBP", 13: "SF", 14: "SH",
        15: "GIDP", 16: "PA", 17: "OBP", 18: "OPS", 19: "FPTS", 20: "R", 21: "RBI",
        23: "SB", 24: "CS", 27: "K", 67: "Ch", 68: "PO", 69: "AST", 71: "FLD%", 72: "E", 73: "DP", 81: "GP",
        // Pitching - see comment above for validation. 34 (Outs/IP) and 32 (G) are intentionally left out of this display map - both get their own dedicated leaderboard column with real baseball formatting instead of running through the generic stat-cell renderer.
        33: "GS", 35: "BF", 36: "PC", 37: "H", 39: "BB", 40: "IBB",
        41: "WHIP", 42: "HBP", 43: "OBP", 44: "R", 45: "ER", 46: "HR", 47: "ERA",
        48: "K", 49: "K/9", 50: "WP", 51: "BK",
        53: "W", 54: "L", 55: "W-L%", 57: "SV", 58: "BS", 59: "SV%", 62: "CG", 63: "QS", 83: "K/9"
    },
    // HOCKEY - fully re-validated against a real completed 2025-26 category league (hockey-cats-2026-league/players captures). The PREVIOUS fhl map here was never validated against a live season and was almost entirely WRONG - every id below except 29/31/32 (SOG/ HIT/BLK, which happened to be right) had the wrong label, e.g. it had 1="G" when 1 is actually Wins, 13="SHP" when 13 is Goals, 38="GAA" when 38 is power-play points. Treating a stat's numeric range as a hint (the same mistake baseball's 69/72 correction warns about) is what produced the bad guesses; these are now anchored to real values. Anchors (Connor McDavid's real 2025-26 line, plus league-wide identities that hold for ALL players, which is far stronger than any single line): - 13(G)=48, 14(A)=90, 16(PTS)=138 and 13+14==16 holds for all 942 skaters -> G, A, PTS. - 18(PPG)+19(PPA)==38 for all skaters -> 38 is PPP (power-play points), 18/19 its parts. - 20(SHG)+21(SHA)==39 for all skaters -> 39 is SHP (shorthanded points), 20/21 its parts. - Goalie-only ids (nonzero for defaultPositionId 5 ONLY): 0,1,2,3,4,6,7,8,9,10,11,12. 3(SA)-4(GA)==6(SV) for goalies (within shootout/empty-net rounding) -> SA, GA, SV. 1(W)+2(L)+9(OTL) == decisions ~= 30(GP) (Vasilevskiy 39+15+4=58=GP) -> W, L, OTL. - 10(GAA) and 11(SV%) are the only DECIMAL goalie categories; 10 is lower-is-better (backups with the worst averages top it) -> GAA, 11 tops out at 1.000 -> SV%. - Leaderboard shape confirms the skater counting cats. 29(SOG) is led by volume shooters (MacKinnon 350), 31(HIT) by grinders (Trenin 412), 32(BLK) by defensemen (McCabe 190), 23(FOW) by centers only (Hischier 1008). 28 is Hat Tricks: values only ever 1/2/3, 77 players with any, elite scorers on top (McDavid 3) - the unmistakable HAT signature. - 15 is +/- (the one skater id with negative values, Boeser -48 to MacKinnon +57). The 14 ids this league actually scores (all confirmed above) are 1,7,10,11,13,14,16,23,28, 29,31,32,38,39. 30(GP) and the raw time-on-ice ids get dedicated handling, not a stat cell. UNVALIDATED, deliberately left OUT of this map rather than guessed (per golden rule 4): 12 (a goalie decimal ~0.5-1.0), 25 (skater ~1000s, likely shifts), 33 (defenseman-only ~17 avg), 35 (skater ~2-3), 36/37 (skater ~4/~7, plausibly takeaways/giveaways). None are scored by any reference league; an unmapped id doesn't render a column (graceful).
    'fhl': {
        // Skaters
        13: "G", 14: "A", 15: "+/-", 16: "PTS", 17: "PIM", 18: "PPG", 19: "PPA",
        20: "SHG", 21: "SHA", 22: "GWG", 23: "FOW", 24: "FOL", 28: "HAT", 29: "SOG",
        31: "HIT", 32: "BLK", 38: "PPP", 39: "SHP",
        // Goalies. 8/26/27 (time on ice in seconds) and 30 (GP) intentionally omitted - GP has its own leaderboard column, and raw-seconds TOI needs its own formatting, not a cell.
        0: "GS", 1: "W", 2: "L", 3: "SA", 4: "GA", 6: "SV", 7: "SO", 9: "OTL", 10: "GAA", 11: "SV%"
    }
};

// Spelled-out names for the abbreviations above, so a category header can read "W (Wins)" instead of leaving the reader to decode "W". Keyed by STAT ID per sport, never by abbreviation, because baseball reuses the same short label for different stats depending on the role. 1 vs 37 are both "H" (hits vs hits allowed), 10 vs 39 both "BB", 20 vs 44 both "R", 5 vs 46 both "HR", 17 vs 43 both "OBP", 27 vs 48 both "K". An abbreviation-keyed map would confidently mislabel one half of every one of those pairs. These are the DOCUMENTED meanings of ids already validated in ESPN_STAT_MAPS above, not new guesses (golden rule 4): the hockey expansions follow the identities recorded there (13+14==16 for G/A/PTS, 3-4==6 for SA/GA/SV, 18+19==38 and 20+21==39 for the power-play and shorthanded pairs), and the baseball ones the batting/pitching split its own comments describe. An id with no entry here shows its abbreviation alone, which is what every surface did before.
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

// Based on real baseball/hockey facts (fewer errors, fewer times caught stealing, a lower ERA are always better), NOT on ESPN's per-league isReverseItem flag - that flag turned out to be inconsistent for the exact same stat (Errors, id 72) between two different real leagues in this same account (reverse in one, not reverse in the other), which isn't something a commissioner would plausibly configure on purpose two different ways for the same category. Don't trust it as a signal for which direction is "better."
export const INVERSE_STATS = {
    // CS, WHIP, HBP, R, ER, HR, ERA, WP, BK, L, OBP(against), BS, E - re-derived after the Skubal/Chapman/Whitlock validation corrected what several of these ids actually are (see comment on ESPN_STAT_MAPS) - e.g. 44 used to be a duplicate "ERA" (correctly inverse by coincidence) and is now known to be R allowed, which is still correctly inverse; 46 used to be assumed IP (NOT inverse) and is now known to be HR allowed, which MUST be inverse.
    flb: new Set(["24", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "50", "51", "54", "58", "72"]),
    // Lower-is-better hockey stats, re-derived with the fhl validation (see ESPN_STAT_MAPS.fhl). Only GAA(10) is scored by the reference cats league; the others (L, GA, OTL, FOL) are inverse facts included so any displayed/ranked value reads correctly. The OLD set {"36","38"} pointed at what were then mislabeled ids (L/GAA under the wrong map).
    fhl: new Set(["2", "4", "9", "10", "24"]) // L, GA, OTL, GAA, FOL
};
// 69 (AST) and 72 (E) are fielding stats, not pitching, despite numerically sitting in this range - excluded here so they sort into the batter group instead of the pitcher one.
export const PITCHING_IDS = new Set(["33", "34", "35", "36", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "53", "54", "55", "57", "58", "59", "62", "63", "83"]);
// Goalie-only stat ids (nonzero for defaultPositionId 5 ONLY, confirmed across the whole 2026 cats pool). Hockey's analogue to PITCHING_IDS. It splits the Goalies tab/group from Skaters everywhere the code asks "is this a secondary-role stat" (see GOALIE_IDS usages). The OLD set {"35".."42"} was pure guesswork against the never-validated map - those ids are all skater stats now (35 unmapped, 38=PPP, 39=SHP,...).
export const GOALIE_IDS = new Set(["0", "1", "2", "3", "4", "6", "7", "8", "9", "10", "11", "12"]);
export const AVERAGE_STATS = {
    // Rate/percentage stats only - a raw counting stat here would make the drill-down chart's reference line use the season TOTAL directly instead of dividing across weeks, which is wrong for a counting stat. 35 (BF), 36 (PC), and 44 (R) used to be misidentified as rate stats under their old, wrong names ("OBP", "SLG", "ERA") - removed now that they're known to be counting stats.
    flb: new Set(["2", "9", "17", "18", "41", "43", "47", "49", "55", "59", "83"]), // AVG, SLG, OBP, OPS, WHIP, OBP-against, ERA, K/9, W-L%, SV%, K/9
    // The two rate categories in hockey, corrected with the fhl validation: 10 is GAA and 11 is SV% (the OLD {"38","41"} labeled them under the wrong map). Both must aggregate by averaging across weeks, not summing, or the drill-down reference line and any windowed total is nonsense (a 2.50 GAA would "sum" to 40+ across a season).
    fhl: new Set(["10", "11"]) // GAA, SV%
};

// Rate/percentage categories reproduced from their raw COMPONENT stats, not by summing or averaging the already-computed daily rate. ESPN's season valuesByStat for a rate stat is the whole-season ratio (e.g. total SV / total SA), so a windowed or started-day total only matches when the components are summed first and the rate derived last - averaging each day's rate weights a 1-shot night the same as a 40-shot night and drifts well off the real number. Keyed by sport so the crediting/aggregation code stays free of any sport-specific branch (it just looks the table up), which is what makes MLB roto work by the same path hockey validates. Each entry: out = the derived stat id; then either { num:[ids], den:[ids], scale? } for a ratio (sum(num) * (scale||1) / sum(den)) or { add:[ids] } to sum other already-derived overrides. Processed in array order so an `add` entry can reference ratios computed before it. fhl: SV%(11) = SV(6)/SA(3); GAA(10) = GA(4) * 3600 / TOI-seconds(8). CONFIRMED against a real goalie daily line (Shesterkin, a 27-save shutout: 6/3 = 27/27 = 1.000; 4*3600/8 = 0). flb: the batting rates that were validated for deriveBattingRateOverrides - AVG/SLG/OBP/OPS from H/AB/TB/BB/HBP/SF. Pitching rates (ERA/WHIP/K-9) are deliberately NOT here. Their component ids are known but no MLB roto fixture exists to confirm the end-to-end reproduction, so they keep the averaged-daily approximation (AVERAGE_STATS) until one does - a one-line addition here when it can be checked, not a guess now (golden rule 4).
export const RATE_COMPONENTS = {
    flb: [
        { out: "2", num: ["1"], den: ["0"] },                                  // AVG = H/AB
        { out: "9", num: ["8"], den: ["0"] },                                  // SLG = TB/AB
        { out: "17", num: ["1", "10", "12"], den: ["0", "10", "12", "13"] },   // OBP = (H+BB+HBP)/(AB+BB+HBP+SF)
        { out: "18", add: ["17", "9"] },                                       // OPS = OBP + SLG
        // PITCHING. VALIDATED against a real 3000-player pool capture. Each formula reproduces ESPN's own reported value on all 1154 pitcher season lines with real innings, to floating point, with zero misses. 34 is OUTS, so innings are 34/3 and the 9-per-inning rates carry a scale of 27. These were the entries deriveRateOverrides called out as "pending an MLB roster fixture"; this capture is that fixture.
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

// Roster slot ids that DON'T count toward standings - bench and injured reserve. A player's daily stats credit their team on a scoring period only when their lineupSlotId that day is NOT in this set ( started-day crediting, from the mRoster daily snapshots). The STARTING set is derived per league as { slot: lineupSlotCounts[slot] > 0 } minus these, so it adapts to each league's own roster construction while the bench/IR ids stay fixed per sport (ESPN's slot catalog is per-sport constant; only the counts vary by league). fhl: 7 = bench (BE), 8 = IR. CONFIRMED against the FGB 2025 daily snapshots - starting slots 3/4/5/6 (F/D/G/UTIL) fill to exactly their lineupSlotCounts caps every day with zero violations, 7/8 hold the overflow, and crediting only slots 3-6 reproduces every team's valuesByStat exactly (sum of per-category deltas = 0 across all 5 teams). flb: 16 = bench (BE), 17 = IL. CONFIRMED against a real in-progress 2026 MLB capture carrying four teams' actual current lineups (B90's validation gate). Every starting slot fills to exactly its lineupSlotCounts cap with zero overflow, all 64 starting entries carry their own lineupSlotId inside that player's eligibleSlots, and 16/17 are the only slots every one of the 83 rostered players is eligible for - the signature of bench and IL, which take anyone. The active MI/CI/UTIL/IF slots DO count.
export const NON_STARTING_SLOTS = {
    flb: new Set([16, 17]),
    fhl: new Set([7, 8])
};

// The order a roster reads in, top to bottom, per sport. Position slots first in ESPN's own catalog order, then the flex/utility slots, then the generic ones - it is the order the fantasy site itself lists a lineup in, so a manager recognizes their own team at a glance. VALIDATED with NON_STARTING_SLOTS above, from the same 2026 MLB capture: flb: 0 C, 1 1B, 2 2B, 3 3B, 4 SS, 5 OF (x3), 12 UTIL, 13 P, 14 SP (x3), 15 RP (x3). Decisive per-slot evidence: slot 3 held four third basemen and slot 4 four shortstops by default position, slot 15 twelve relievers, while 12 and 16 held mixed roles as a utility and a bench slot must. 6 MI, 7 CI and 19 IF are catalog slots this league does not roster (count 0) and so were not observed; they are ordered here on the SLOT_POSITION_MAPS reading and will show up the first time a league rosters them. fhl: 3 F, 4 D, 5 G, 6 UTIL, from the snapshot validation recorded above. Any slot a league rosters that is missing from this list still renders, appended in id order, so an unfamiliar roster construction degrades to a sane list rather than dropping players.
export const LINEUP_SLOT_ORDER = {
    flb: [0, 1, 2, 3, 4, 6, 7, 19, 5, 12, 13, 14, 15],
    fhl: [3, 4, 5, 6]
};

export const POSITION_MAPS = {
    flb: { 0: "P", 1: "SP", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH", 11: "RP" },
    fhl: { 1: "C", 2: "LW", 3: "RW", 4: "D", 5: "G" }
};

// eligibleSlots uses ESPN's roster-slot id catalog - a completely different numbering scheme from defaultPositionId above. Confirmed against real eligibleSlots on 5 different 2025/2026 players (a 2B/SS utility infielder, a healthy starting pitcher, an OF who plays CF/RF, a two-way DH/SP, and a 3B/DH corner bat) - each decoded slot combination matched that player's known real-world eligibility exactly. OF is displayed at whatever granularity this specific league's roster actually uses (generic "OF" vs specific LF/CF/RF) via AppState.leagueActiveSlots - see computeEligiblePositions in players.js. Every OTHER slot here (DH, infield positions, pitching roles) is shown whenever a player is eligible for it, regardless of whether the league happens to have a dedicated roster spot for it - conflating "no roster slot for this" with "not eligible for this" was a real bug. A DH-capable batter was losing "DH" entirely on leagues with no dedicated DH bench slot, even though DH eligibility describes the player, not the league's roster construction. Excludes pure roster-status slots (6=MI, 7=CI, 12=UTIL, 16=BE, 17=IL, 19=IF) since those are never real defensive positions. No confirmed mapping for hockey yet - multi-position display falls back to defaultPositionId there.
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
    // THE sport of the league currently LOADED, set by processCoreData from the payload's own gameId. Every view of loaded data reads its stat maps, position maps and role groups from here, never from the #sport dropdown. The dropdown is an input for the NEXT fetch, and a user browsing it re-rendered the loaded pool under the other sport's rules, which left the leaderboard showing a handful of accidental survivors. Derived from the payload rather than captured from the form so a restored session is right too, and so nothing can drift.
    loadedSport: 'flb',
    isPointsLeague: false,
    // Season-long roto (scoringType 'ROTO'). Standings accumulate over the whole season with no weekly matchups, so the entire Team Metrics pipeline (which is matchup-based) has nothing to stand on. Detected in data.js; the Team Metrics renderers show a "not supported yet" notice instead of a broken view. Player Metrics still works (the pool and rank engine are matchup-agnostic), so this flag deliberately gates only the Team Metrics tab.
    isRotoLeague: false,
    leagueHistoryYears: [],
    maxCompletedWeek: 1,
    regSeasonWeeks: 16,
    // Whether this league's season has actually FINISHED, derived in data.js from the payload's own schedule status. Distinct from maxCompletedWeek, which mid-season only means "last completed matchup" - keying an end-of-season marker off that drew it before the in-progress matchup and claimed the season was over while it was still running.
    isSeasonOver: false,
    // The matchup being PLAYED right now (status.currentMatchupPeriod), which is one past maxCompletedWeek on the morning before its first game. 0 when the season is over or unknown.
    currentMatchup: 0,
    // statId -> points per unit, from the league's own scoringSettings.scoringItems. Only a points league uses it, where the weighted stat line IS the player's fantasy total (VALIDATED: it reproduces ESPN's appliedTotal exactly). Empty for category and roto leagues.
    scoringWeights: {},
    // Category Heatmap column sort: the scored stat id whose column the rows are ordered by, or null for the league's default team order. Lives here rather than in graphs.js so the state carries between the inline band and the pop-out overlay, which share one renderer.
    heatmapSortCat: null,
    heatmapSortDir: 'desc',
    // The draft picks + executed transaction log for the current league, harvested once per session for the transaction-accurate Roto Race. { key: 'sport:leagueId:year', picks, transactions } when loaded; null before the harvest, or after it fails/finds nothing (the race then falls back to current rosters - golden rule 8). The key guards against serving a previous league's log.
    rosterTransactionData: null,
    // The league's daily roster SNAPSHOTS, harvested once per session for the lineup-aware Roto Race: { key: 'sport:leagueId:year', days: { scoringPeriodId: [{ id, entries: [{ p, slot }] }] } }. Each day carries every team's full roster with the lineupSlotId each player sat in THAT day, which is the only source that says who was STARTED vs benched (the transaction LINEUP items can't - their from-slots reference proposal-time state, not the application day). Null before the harvest or after it fails/finds nothing, in which case the race steps down the fallback ladder to the transaction timeline and then current rosters (golden rule 8). Key-guarded so a previous league's snapshots are never served.
    rosterSnapshotData: null,
    championTeamId: null,
    scoredStatIds: new Set(),
    leagueActiveSlots: new Set(),
    // The logged-in user's SWID (from the ESPN cookie, captured in checkAuth) - used to auto-detect "my team" for the team-specific weekly recap by matching against each team's primaryOwner/owners. Empty when unknown (e.g. cookie missing, or the dev preview stub).
    userSwid: '',

    // The ONE shared timeframe selection - drives Team Metrics graphs, the Player Metrics leaderboard's ranks/stats, and the player drill-down chart, all at once (see rebuildTimeframeOptions in controls.js). Replaces two previously-separate controls (Team Metrics' own #timeframe select and the player drill-down's own #player-timeframe select) that did the same job with near-duplicate option-building logic.
    timeframe: 'all',

    // The Rankings box (Team Metrics, right-hand 40% column) switches between Team Rankings - the standings bars/pies ('standings') - and Category Rankings + its category picker ('category') via the box's header tabs (see main.js).
    rankingsBoxView: 'standings',

    playerData: [],
    playerDataLoaded: false,
    // Why the pool is missing, when it is. The league payload can load without cookies while the pool cannot, so "no players" is a state several tabs have to explain, not just the one that made the request. null means nothing has failed.
    playerDataError: null,
    // The same for the league payload itself, which a private league refuses outright when logged out. Set only when the login is the reason, since that is the only failure logging in fixes.
    leagueDataError: null,
    // The pro sports schedule for the loaded sport and season, keyed so a league switch to another sport or year refetches rather than counting starts against the wrong calendar.
    proTeamSchedules: null,
    // The day's scoreboard, which is where the betting lines live. Keyed by sport and HOUR, not cached to storage. A line moves during the day and a stale price is worse than none.
    scoreboardOdds: null,
    // Betting lines are opt-in and OFF by default. While false the scoreboard is not fetched at all, so an install that never opts in makes no betting-related request.
    showBettingOdds: false,
    playerSortStat: 'rotoScore',
    playerSortDir: 'desc',
    playerSearchQuery: '',
    playerPositionFilter: 'ALL',
    // Roster availability filter for the leaderboard: 'all' (everyone), 'rostered' (on a fantasy team), or 'fa' (free agents). Availability comes from a player's teamId - see processPlayerData (onTeamId > 0 means rostered).
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
