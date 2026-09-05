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
    },
    // ==== FOOTBALL. VALIDATED by EXACT REPRODUCTION, the strongest bar available for a points league: the league's own scoring weights multiplied over each player's season line reproduce ESPN's own appliedTotal for ALL 1,091 PLAYERS IN THE POOL to within a tenth - 1,059 humans and all 32 D/ST entities. That sweep validates every one of the 46 scored ids' SEMANTICS at once, because a wrong id would have to be cancelled by another wrong id in every one of a thousand different stat lines to survive it. Reproduction validates the MATHS. Naming is a separate claim, and only the ids below earned one. Each was decided by weight, by which positions carry it, by magnitude, and by an internal identity that has to hold if the name is right: 3/4/20 Stafford 597 attempts, 388 completions (65.0%), 4707 yards at 12.1 a completion, 46 touchdowns against 8 interceptions. Nix 63.4% and 10.1. Real quarterback lines. 53/42/43 Nacua 129 receptions for 1715 yards is 13.3 a catch; Smith-Njigba 15.1. A 1-point-per-reception id maxing at 129 is receptions in a PPR league. 80/77/198/201 the four field-goal buckets decline monotonically with distance on every kicker measured - Dicker 21/12/5/0, Fairbairn 19/16/9/0 - and the ONLY kicker with makes in the 6-point bucket is Aubrey, whose long range is the reason that bucket is scored at all. Buckets, in distance order, confirmed by their own shape. 19/26/44 two points each, one per scoring route, tiny counts. Two-point conversions. ID 19 IS THE CANONICAL REASON THE ENGINE IS KEYED BY SPORT, and it is recorded here with its measurement rather than its conclusion. The plan for this work said to treat 19 as the every-sport generic FPTS and exclude it. Excluding it left THIRTY QUARTERBACKS short by exact multiples of two - Bo Nix by 8 against 4 of them, Prescott by 6, Mahomes by 4 - and including it took the pool from 1,029 of 1,059 reproducing to all of them. In baseball 19 IS the generic points total (see ESPN_STAT_MAPS.flb). Same bare number, different statistic, one sport apart. THE D/ST IDS, SETTLED BY THE PER-GAME LOG the season totals could not settle. One club's 17 weekly lines carry the raw points and yards it allowed each week (ids 120/187 and 127), and the brackets are mutually exclusive, so crossing "what was allowed" against "which bracket fired" reads the ladder straight off the data: points allowed 89 fired on 0 alone 91 on 10, 10 and 13 92 on 14, 15, 16, 16 and 17 123 on 29 and 30 a zero-weight bracket took 18, 19, 20, 20, 21 and 27 yards allowed 129 on 175 130 on 207 through 296 132 on 354 and 360 a zero-weight bracket took 307 through 326 Non-overlapping, and three boundaries are pinned EXACTLY because adjacent brackets sit on either side of them: 13|14 between 91 and 92, 17|18 between 92 and the unscored one, and 27|28 between that one and 123. The outer edges of 91, 123, 129, 130 and 132 are the conventional ones and are the only ladder consistent with every observation - said here rather than in the label, because an inferred edge is still an inference. The counting ids fell to LEAGUE-WIDE IDENTITIES, which are stronger than any single line: 95 = 380 across all 32 defences, and 380 is EXACTLY the interceptions thrown by every quarterback in the pool (id 20). Every interception thrown is one caught. 96 = 242 against 241 fumbles lost (id 72) - one apart, which is a recovery of a fumble by somebody the pool does not carry. 99 = 1,285 across 32 clubs, forty a club a season, which is what a sack total looks like, and 1 to 8 in a week. 98 = 12 league-wide with no club posting more than one. A safety. STILL DARK, and named as such rather than guessed. Ids 90, 124, 125, 128, 133, 134, 135 and 136 are brackets this one club never landed in across 17 weeks - a defence that never allowed 1-6 points or over 400 yards teaches nothing about those rows, and a second club's log would settle them. Id 97 (44 league-wide, never more than 4 for a club) matches no identity on the offensive side. Ids 93, 101, 102, 103 and 104 are all worth 6 and are touchdown routes that this evidence cannot tell apart. All of them still SCORE correctly - the reproduction proves the arithmetic regardless of what a column is called. THREE MORE, recorded because they were scored and written down nowhere - the profiler counts 46 scored ids in this league against 29 named, and these are the three the list above did not account for: 63 one player carries it, a running back, value 1, worth SIX POINTS. Six and a back is a touchdown route, so it joins 93 and 101-104 in the family this evidence cannot split. 206 two players carry it, both team defences (defaultPositionId 16), value 1 each, worth TWO with a slot override - a two-point play credited to a defence. One club-season of two instances names nothing. 209 scored, worth 1 with an override, and carried by NOBODY in the pool. A row the league will pay for and nobody has posted, so there is no evidence in this capture at all. As with the rest, they SCORE correctly whatever they are called; what is missing is a name, and a second club's log is what would supply one. ====
    'ffl': {
        // Passing
        3: "PYDS", 4: "PTD", 19: "2PTP", 20: "INT",
        // Rushing
        24: "RYDS", 25: "RTD", 26: "2PTR",
        // Receiving
        42: "REYDS", 43: "RETD", 44: "2PTRE", 53: "REC",
        // Ball security
        72: "FUML",
        // Kicking, by distance bucket 85 IS FIELD GOALS MISSED, and "FGM" read as "made". Its identity was never in doubt and is not changed here - only the abbreviation, which collided with the exact opposite of what the column holds. Measured on full-nfl: 38 players carry it, every one a kicker (defaultPositionId 5), max 8, and the league weights it -1 while the MADE ladder sits beside it at 80/77/198/201 worth 3, 4, 5 and 6 by distance. A "made" statistic does not score negative next to four positive made buckets.
        80: "FG0-39", 77: "FG40-49", 198: "FG50-59", 201: "FG60+", 85: "FGMISS", 86: "XP",
        // Team defence: the plays, then the two bracket ladders. Only the rows the log lit up.
        95: "DINT", 96: "FR", 98: "SFTY", 99: "SACK",
        89: "PA0", 91: "PA7-13", 92: "PA14-17", 123: "PA28-34",
        129: "YA100-199", 130: "YA200-299", 132: "YA350-399"
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
    },
    // Football. Only the ids ESPN_STAT_MAPS.ffl names - see the validation note there for what is deliberately absent and why.
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

// Based on real baseball/hockey facts (fewer errors, fewer times caught stealing, a lower ERA are always better), NOT on ESPN's per-league isReverseItem flag - that flag turned out to be inconsistent for the exact same stat (Errors, id 72) between two different real leagues in this same account (reverse in one, not reverse in the other), which isn't something a commissioner would plausibly configure on purpose two different ways for the same category. Don't trust it as a signal for which direction is "better." The sport's name in the user's words, for the one line a surface shows when it cannot show numbers. Keyed here beside the other per-sport tables so a new sport adds one row rather than a string in four render functions.
export const SPORT_NAMES = { flb: 'Baseball', fhl: 'Hockey', ffl: 'Football' };

// Football's roster split, the owner's ruling and the analogue of batters/pitchers and skaters/goalies: every human on one side, the team defences on the other. A D/ST is not a player with unusual statistics, it is a different kind of entity - it has no games played, no headshot, and its scored ids overlap none of a human's - so ranking the two together would compare things that share no categories. MEMBERSHIP IS defaultPositionId 16, validated rather than assumed: all 32 D/ST entities in the pool carry it, no human does, and it agrees exactly with the other candidate signal (a negative player id) on all 1,091 players. Position is the load-bearing test because it is the same field every other sport's split already reads; the negative id is a corroborating curiosity.
export const DST_POSITION_ID = 16;

// WHETHER THIS SPORT'S CATEGORIES ARE VALIDATED, which is the gate every category surface asks before it draws a number. ESPN_STAT_MAPS is the register of ids validated against real stat lines (golden rule 4), so a sport absent from it has nothing anyone has checked - and a column of real values under a heading nobody validated is precisely the confident-and-wrong output the rule exists to prevent. Football is selectable before its ids are mapped, on purpose: the league has to load before its capture can be downloaded, and the capture is what will validate them.
export function categoriesMapped(sport) {
    const map = ESPN_STAT_MAPS[sport];
    return !!map && Object.keys(map).length > 0;
}

// THIS TABLE IS NOT THE WHOLE ANSWER FOR A POINTS LEAGUE. It holds the categories a SPORT ranks backwards, validated per sport, and it has no football entry because no football category league has been measured. A points league still shows categories on some surfaces, and there the league's OWN scoring weights say which read better low: a negative weight is the league saying so, and needs no stat-id knowledge. Union the two through lowerIsBetterIds just below - reading this table alone named leading the league in FUMBLES LOST as a manager's best category. Which ids read BETTER LOW, from the league's own scoring weights on top of the sport's validated inverse table. THE LEAGUE ANSWERS, NOT A TABLE - the same rule that decided a slot-scored id is a secondary statistic. This exists because of a wrong answer it produced. INVERSE_STATS has entries for baseball and hockey and none for football, which is correct as far as it goes - a football CATEGORY league is rare and none has been measured. But a points league still has categories on this card, and read through the bare table the football capture named FUML (fumbles lost) as a manager's BEST category because that manager led the league in it, and INT as the worst for throwing the fewest. Exactly backwards, in the one card whose whole job is to say what they were good at. A weight the league itself set to a negative number is the league saying lower is better, and it needs no stat-id knowledge to read. Ids 20, 72 and 85 carry -2, -2 and -1 in the measured league: interceptions thrown, fumbles lost, field goals missed.
export function lowerIsBetterIds(baseInverse, weights) {
    const out = new Set(baseInverse || []);
    Object.entries(weights || {}).forEach(([id, w]) => {
        if (Number(w) < 0) out.add(String(id));
    });
    return out;
}

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

// Roster slot ids that DON'T count toward standings - bench and injured reserve. A player's daily stats credit their team on a scoring period only when their lineupSlotId that day is NOT in this set. The STARTING set is derived per league as { slot: lineupSlotCounts[slot] > 0 } minus these, so it adapts to each league's own roster construction while the bench/IR ids stay fixed per sport (ESPN's slot catalog is per-sport constant; only the counts vary by league). fhl: 7 = bench (BE), 8 = IR. CONFIRMED against the FGB 2025 daily snapshots - starting slots 3/4/5/6 (F/D/G/UTIL) fill to exactly their lineupSlotCounts caps every day with zero violations, 7/8 hold the overflow, and crediting only slots 3-6 reproduces every team's valuesByStat exactly (sum of per-category deltas = 0 across all 5 teams). flb: 16 = bench (BE), 17 = IL. CONFIRMED against a real in-progress 2026 MLB capture carrying four teams' actual current lineups. Every starting slot fills to exactly its lineupSlotCounts cap with zero overflow, all 64 starting entries carry their own lineupSlotId inside that player's eligibleSlots, and 16/17 are the only slots every one of the 83 rostered players is eligible for - the signature of bench and IL, which take anyone. The active MI/CI/UTIL/IF slots DO count. THE BENCH-AND-INJURY NAMING CONVENTION, in one place because two surfaces were about to disagree about the same seat. Within a sport's non-starting pair the LOWEST id is the bench and the rest are the injury slot - baseball calls its one IL, the other sports IR. THIS IS AN INFERENCE, NOT A VALIDATED FACT, and it is written down here so it is corrected in one edit rather than three. What IS validated is the pair itself: both slots take every player in the pool, which is why NON_STARTING_SLOTS can name them non-starting with confidence. Which of the two is the bench rests on ESPN's ordering pattern, and on the count shape where the counts differ (hockey 5 against 1, football 7 against 1). Baseball's are 3 against 3, so ordering is all there is there. My Team has been showing users this inference since; the pre-draft ground now shows the same one, because two faces printing different words for one seat is worse than a shared inference honestly labelled. BASEBALL NO LONGER USES THIS PATH. The owner's live-league mRoster capture put every injured player in slot 17 and none in 16, so flb 16/17 are in the catalog above as BE and IL and the catalog wins. The inference was RIGHT, which is the outcome worth recording: what changed is that both surfaces now print a measured label instead of an ordering guess that happened to agree. Hockey and football still ride the gap below - see the fhl note above for what a finished season's roster could and could not settle.
export function nonStartingLabels(sport) {
    const ids = [...(NON_STARTING_SLOTS[sport] || new Set())].sort((a, b) => a - b);
    const catalog = LINEUP_SLOT_LABELS[sport] || {};
    const injury = sport === 'flb' ? 'IL' : 'IR';
    const out = {};
    // The CATALOG WINS where it has an entry - those labels carry their own evidence (football's and hockey's count shapes) and this function must not quietly outvote them. The lowest-id inference fills only the gap, which today is baseball's 16 and 17.
    ids.forEach((id, i) => { out[id] = catalog[id] || (i === 0 ? 'BE' : injury); });
    return out;
}

export const NON_STARTING_SLOTS = {
    flb: new Set([16, 17]),
    fhl: new Set([7, 8]),
    // Football's bench and injury slots. Both take every player in the pool - the signature this set exists to capture - so neither credits a lineup. See LINEUP_SLOT_LABELS.ffl for what the crossing proved and what it could not.
    ffl: new Set([20, 21])
};

// Which STARTING slots belong to the second role group - the one the Player tab calls secondary. Read off the same validated slot catalog as NON_STARTING_SLOTS and LINEUP_SLOT_ORDER directly above, not guessed: baseball's pitching slots are 13 P, 14 SP and 15 RP, and hockey's only non-skater starting slot is 5 G. Everything else that starts is primary, so a flex or utility slot lands with the batters and the skaters, which is what it is. This is what turns a league's lineup settings into "how many pitchers does this league start", which is the number replacement level is taken at. What each starting slot is CALLED, for the one surface that has to name a league's roster shape back to its owner. Not a new reading of the catalog: every one of these is written down in the LINEUP_SLOT_ORDER validation note above, from the same captures - flb 0 C, 1 1B, 2 2B, 3 3B, 4 SS, 5 OF, 6 MI, 7 CI, 12 UTIL, 13 P, 14 SP, 15 RP, 19 IF, and fhl 3 F, 4 D, 5 G, 6 UTIL. SLOT_POSITION_MAPS stays what it is, an ELIGIBILITY decoder; this is a display label, and the two answer different questions (that map has no entry for a flex slot because no player is "eligible at UTIL", but a roster line still has to say the league starts one). HOCKEY SLOTS 0, 1 AND 2 VALIDATED, by the same eligibility crossing that decided the baseball slots, and added because a real league was found starting THREE of slot 0 per team - a dozen and a half starting jobs the app could not name, and so could not put on the roster card, in the depth card or into a bot's needs. Measured across the 1039-player 2026 hockey pool, slot against defaultPositionId: slot 0: 304 eligible - ALL 274 centres, plus 13 LW and 17 RW, and no D or G at all slot 1: 257 eligible - ALL 169 left wings, plus 63 C and 25 RW slot 2: 245 eligible - ALL 172 right wings, plus 45 C and 28 LW slot 3: 615 - every forward and nothing else (F) slot 4: 327 - every D, only D slot 5: 97 - every goalie, only goalies slot 6: every skater, no goalie (UTIL) A slot that every centre can fill and no defenceman or goalie can is the centre slot; the wingers who also appear there are the dual-position players, which is what dual eligibility means. The same reading names 1 and 2. Slot 10 exists on twelve mixed players and is NOT named here - no league in the captures rosters it, so nothing decides it.
export const LINEUP_SLOT_LABELS = {
    flb: { 0: 'C', 1: '1B', 2: '2B', 3: '3B', 4: 'SS', 5: 'OF', 6: 'MI', 7: 'CI', 8: 'LF', 9: 'CF', 10: 'RF', 11: 'DH', 12: 'UTIL', 13: 'P', 14: 'SP', 15: 'RP', 16: 'BE', 17: 'IL', 19: 'IF' },
    // HOCKEY'S BENCH AND INJURY SLOTS, named on the same footing football's already stand on: NON_STARTING_SLOTS validated 7 and 8 as the non-starting pair (the signature is that both take every player in the pool), and the COUNT SHAPE says which is which - a bench holds more places than an injury slot. Measured across every hockey capture in the corpus, slot 7 is 5 in all 29 while slot 8 varies between 1 and 3, and 7 exceeds 8 in every one. Those 29 are not 29 independent leagues - most are synthetic clones of a handful of real ones - so the honest claim is that the shape is consistent wherever it has been seen, not that it has been seen 29 times. STILL NOT PROVEN, and a hockey mRoster capture was CHECKED and did not prove it - recorded so the next reader does not spend the check again. That roster (5 teams, 113 entries, a FINISHED 2025 roto season) puts slot 7 at 23 and slot 8 at 5, which matches the count shape. But the injury reading that settled baseball's pair does not work here: the injured are scattered across four slots, and TWO players carrying INJURY_RESERVE were sitting in STARTING slots 3 and 4, while slot 8 held four ACTIVE players and one OUT. Nobody tidies a lineup after the season ends, so a finished season cannot answer where the injured belong. It takes a LIVE hockey league captured with mRoster, the way the live baseball one settled 16 and 17. Both are non-starting either way, which is the load-bearing fact and is validated. BASEBALL'S 16 AND 17 ARE NOW FACT, not the count shape (, the owner's own live 4-team 2026 league captured WITH mRoster - the capture this entry had been waiting for). Read straight off the roster, 80 entries: slot 17 held 4 players, one per team, and EVERY injured player in the league was in it - SIXTY_DAY_DL, TEN_DAY_DL, TEN_DAY_DL, all three carrying injured: true slot 16 held 12, three per team, and none of them was on a DL An injury slot is where the injured are, and all of them were in 17 and none in 16. So 16 is the bench and 17 is the IL, which is what nonStartingLabels' lowest-id-is-bench inference had been showing since - the inference was right and is now retired for baseball rather than merely trusted. Two entries do NOT fit the tidy version, and are recorded because a reader who checks will find them: one slot-17 player reads ACTIVE, which is a stint that ended without the manager moving the row back, and one slot-16 player reads DAY_TO_DAY with injured: false, which is the point - day-to-day is not an IL stint, so the bench is exactly where that belongs. Neither weakens the reading; the second supports it. The count shape would have said the same thing HERE (12 against 4) and that is precisely why it was refused: the league this entry was originally measured on had 3 against 3. A rule that answers in one league and shrugs in another was never evidence.
    fhl: { 0: 'C', 1: 'LW', 2: 'RW', 3: 'F', 4: 'D', 5: 'G', 6: 'UTIL', 7: 'BE', 8: 'IR' },
    // FOOTBALL, VALIDATED by the same eligibility crossing that decided hockey's slots, over the 1,091-player pool. Each of these is decisive on its own: slot 0 - 131 eligible, ALL 131 quarterbacks and nobody else slot 2 - all 266 running backs slot 4 - all 389 wide receivers slot 6 - all 208 tight ends slot 17 - all 63 kickers, only kickers slot 16 - all 32 team defences, only team defences slot 23 - 864 eligible: every receiver, back and tight end, and NO quarterback, kicker or defence. That composition is what a FLEX is. 20 and 21 both take every player in the pool, which is the signature of the bench and the injury slot - the same pair-of-everyone-slots hockey and baseball have. Which is which is NOT settled by this capture, because it carries no rosters: they are labelled from the count shape (7 bench places against 1) and the cross-sport ordering, and a capture with mRoster would prove it. Both are non-starting either way, which is the load-bearing fact. DELIBERATELY UNNAMED: slots 3, 5 and 7 are real multi-position flexes this league does not roster (3 is backs and receivers, 5 receivers and tight ends, 7 adds quarterbacks), and 25 takes a partial mix of everything, so no honest label exists for it. Naming an unrostered slot from its composition alone would be inventing ESPN's word for it.
    ffl: { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'BE', 21: 'IR', 23: 'FLEX' }
};

export const SECONDARY_LINEUP_SLOTS = {
    flb: new Set([13, 14, 15]),
    fhl: new Set([5]),
    // Football's second group is the team defences, and slot 16 is the only place one can start.
    ffl: new Set([16])
};

// The order a roster reads in, top to bottom, per sport. Position slots first in ESPN's own catalog order, then the flex/utility slots, then the generic ones - it is the order the fantasy site itself lists a lineup in, so a manager recognizes their own team at a glance. VALIDATED with NON_STARTING_SLOTS above, from the same 2026 MLB capture: flb: 0 C, 1 1B, 2 2B, 3 3B, 4 SS, 5 OF (x3), 12 UTIL, 13 P, 14 SP (x3), 15 RP (x3). Decisive per-slot evidence: slot 3 held four third basemen and slot 4 four shortstops by default position, slot 15 twelve relievers, while 12 and 16 held mixed roles as a utility and a bench slot must. 6 MI, 7 CI and 19 IF are catalog slots this league does not roster (count 0) and so were not observed; they are ordered here on the SLOT_POSITION_MAPS reading and will show up the first time a league rosters them. fhl: 3 F, 4 D, 5 G, 6 UTIL, from the snapshot validation recorded above. Any slot a league rosters that is missing from this list still renders, appended in id order, so an unfamiliar roster construction degrades to a sane list rather than dropping players.
export const LINEUP_SLOT_ORDER = {
    flb: [0, 1, 2, 3, 4, 6, 7, 19, 5, 12, 13, 14, 15],
    // Football, in the order a lineup card reads: the named skill positions, then the flex, then the two specialist slots. Same rule as the other sports.
    ffl: [0, 2, 4, 6, 23, 17, 16],
    // 0 C, 1 LW and 2 RW join the hockey order on the 2026 validation recorded with LINEUP_SLOT_LABELS, in the same shape the rule above describes: the named position slots in ESPN's own catalog order, then the flex ones. A league starting centres was previously appending them AFTER the utility slot, because they were not in this list at all.
    fhl: [0, 1, 2, 3, 4, 5, 6]
};

// S24: football's kicking family in a fixed DISPLAY order, not ESPN's numeric stat-id order - the ladder's own ids (77 FG40-49, 80 FG0-39, 85 FGMISS, 86 XP, 198 FG50-59, 201 FG60+) were never assigned in the ladder's own sequence, so a plain numeric sort of a league's scored ids reads FG40-49 before FG0-39. preferScoredDedup's caller applies this as a final ordering pass; ids outside a sport's list here are untouched and keep their existing numeric order.
export const STAT_DISPLAY_ORDER = {
    ffl: ["80", "77", "198", "201", "85", "86"]
};

export const POSITION_MAPS = {
    flb: { 0: "P", 1: "SP", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH", 11: "RP" },
    fhl: { 1: "C", 2: "LW", 3: "RW", 4: "D", 5: "G" },
    // Football. Positions 9 and 12 appear on exactly ONE player each - a defensive lineman listed at fullback and a defensive back - in a league that rosters neither of their slots. One player is not evidence for a position name, so they are left out and render unnamed.
    ffl: { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" }
};

// eligibleSlots uses ESPN's roster-slot id catalog - a completely different numbering scheme from defaultPositionId above. Confirmed against real eligibleSlots on 5 different 2025/2026 players (a 2B/SS utility infielder, a healthy starting pitcher, an OF who plays CF/RF, a two-way DH/SP, and a 3B/DH corner bat) - each decoded slot combination matched that player's known real-world eligibility exactly. OF is displayed at whatever granularity this specific league's roster actually uses (generic "OF" vs specific LF/CF/RF) via AppState.leagueActiveSlots - see computeEligiblePositions in players.js. Every OTHER slot here (DH, infield positions, pitching roles) is shown whenever a player is eligible for it, regardless of whether the league happens to have a dedicated roster spot for it - conflating "no roster slot for this" with "not eligible for this" was a real bug. A DH-capable batter was losing "DH" entirely on leagues with no dedicated DH bench slot, even though DH eligibility describes the player, not the league's roster construction. Excludes pure roster-status slots (6=MI, 7=CI, 12=UTIL, 16=BE, 17=IL, 19=IF) since those are never real defensive positions. No confirmed mapping for hockey yet - multi-position display falls back to defaultPositionId there. THE FLEX SEATS, PER SPORT. A flex seat takes whoever is left over, so it is not a position anyone can be scarce at - counting it as one prints a shortage that cannot be filled by definition. positionDepth used to carry this as a hardcoded list of LABELS ('UTIL', 'IF', 'MI', 'CI', 'P'), which is three sports' vocabulary living in a pure engine, and football's FLEX was missing from it: every football league read "FLEX cliff, none above replacement", always. MEASURED, not inferred, because the obvious data-driven rule does not work. "A slot absent from SLOT_POSITION_MAPS[sport] is a flex seat" fails twice: that map has NO fhl key at all, so every hockey slot would read as flex and the whole scarcity read would vanish for one sport, and flb's map CONTAINS 13 'P', the generic pitcher seat the old list excluded on purpose. Matching on POSITION_MAPS names instead fails the other way - baseball's LF, CF and RF are real scarce positions whose names that map does not carry. flb and fhl reproduce the old list slot for slot, so only the football entry changes behaviour - except fhl 3, which is measured below and is new. FHL 3 ('F') IS A PHANTOM OF THE SAME KIND, and a larger one than football's. Measured on both hockey captures: 959 of 1,655 and 994 of 1,713 players are ELIGIBLE at slot 3, so the seat is genuinely fillable - but ZERO players can ever carry the position NAME 'F', because hockey has no SLOT_POSITION_MAPS entry and every player falls back to one default name out of POSITION_MAPS.fhl (C, LW, RW, D, G). assignBodies matches NAMES against the jobs table, so 'F' is a job nobody can hold. Both leagues roster it heavily - 9 seats a team in one, 6 in the other, against football's single FLEX - so this was the biggest phantom of the three and nobody had reported it.
export const FLEX_SLOTS = {
    flb: new Set([6, 7, 12, 13, 19]),   // MI, CI, UTIL, P, IF
    fhl: new Set([3, 6]),               // F, UTIL
    ffl: new Set([23])                  // FLEX
};

// WHICH POSITIONS A FLEX SEAT ACTUALLY ACCEPTS - validated, never assumed (golden rule 4). A flex seat is not "anyone": football's FLEX takes running backs, receivers and tight ends and refuses quarterbacks and kickers, and that is the difference between a replacement level that means something and one that prices every kicker below the line. Measured on full-nfl-2026 by reading eligibleSlots off every player in the pool and counting which defaultPositionId values appear under each slot - each set below is COMPLETE, every player of that position appearing: slot 3 RB 239, WR 376 (the RB/WR flex) slot 5 TE 200, WR 376 (the WR/TE flex) slot 7 QB 131, RB 239, TE 200, WR 376 (superflex - a quarterback may sit here) slot 23 RB 239, TE 200, WR 376 (the ordinary FLEX; no QB, no K, no D/ST) The same pass confirmed the single-position slots already in SLOT_POSITION_MAPS below - 0 QB, 2 RB, 4 WR, 6 TE, 16 D/ST, 17 K - so the two tables are read off one measurement. Hockey was added by O13 and baseball by O15, each from its own captures; an absent sport would mean "not measured yet", never "takes nobody". WHICH RANKING POOL A FLEX SEAT IS MEASURED AGAINST IS ALREADY RECORDED - it is SECONDARY_LINEUP_SLOTS, and no second table says it. A flex slot in that set belongs to the secondary group; one outside it belongs to the primary. Measured in all three sports, and the two readings agree everywhere: flb slot 13 is in SECONDARY, and accepts every pitcher and no complete batter position; slots 6, 7, 12 and 19 are outside it, and accept only batters. fhl slots 3 and 6 are outside SECONDARY, and accept forwards and skaters, never a goalie. ffl slot 23 is outside SECONDARY, and accepts RB, TE and WR, never the D/ST. This matters because a flex seat measured against the wrong pool is not a small error: a probe that assumed baseball's P slot belonged to the batters priced four pitching seats against 646 batters and reported a number that meant nothing. A second tag would be a second thing to keep in step, and the first time the two disagreed nobody could say which was right.
export const FLEX_SLOT_POSITIONS = {
    // BASEBALL, validated off full-mlb by the COMPLETENESS TEST: a position belongs to a flex slot only when EVERY player of that position is eligible there, so a cross-eligible stray never promotes its own position into the set. The names then fall out of the memberships rather than being assumed: slot 6 MI ALL 210 SS, ALL 157 2B 3B 52 of 161, OF 29, 1B 12 - strays, excluded slot 7 CI ALL 161 3B, ALL 136 1B 2B 43 of 157, SS 40, C 20 - strays slot 19 IF ALL of SS, 3B, 2B, 1B C only 20 of 233, so a catcher is NOT an infielder however many can cover there slot 12 UTIL ALL of C, 1B, 2B, 3B, SS, and NOT ONE pitcher OF and DH slot 13 P ALL 846 RP and ALL 672 SP OF 3, C 3, DH 2 - the two-way players Middle infield is second and short, corner infield is first and third, the infield is those four without the catcher, UTIL is every batter and P is every pitcher. Each entry is the complete group or it is not in the set.
    flb: {
        6: new Set(["2B", "SS"]),
        7: new Set(["1B", "3B"]),
        12: new Set(["C", "1B", "2B", "3B", "SS", "OF", "DH"]),
        13: new Set(["SP", "RP"]),
        19: new Set(["1B", "2B", "3B", "SS"])
    },
    // Hockey, from the same pass as SLOT_POSITION_MAPS.fhl below: slot 3 accepts every forward (positions 1, 2 and 3) and NO defenceman or goalie, which is what makes it the F seat; slot 6 accepts every skater and no goalie, which makes it UTIL. Both counts are exact across the two captures - 429+288+277 and +537 on full-nhl, 400+287+272 and +517 on full-nhl-2.
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

export const SLOT_POSITION_MAPS = {
    flb: { 0: "C", 1: "1B", 2: "2B", 3: "3B", 4: "SS", 5: "OF", 8: "LF", 9: "CF", 10: "RF", 11: "DH", 13: "P", 14: "SP", 15: "RP" },
    ffl: { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K" },
    // HOCKEY, added O13, and its absence was a real defect rather than a gap: with no entry here every hockey player fell back to a single default position name, so a winger who is also eligible at centre was invisible - the app could not see a C/LW at all, and every position-aware surface read hockey as a sport of single-position players. VALIDATED the same way FLEX_SLOT_POSITIONS was, by reading eligibleSlots against defaultPositionId across BOTH hockey captures, and the two agree exactly: full-nhl (2026) full-nhl-2 (2025) slot 0 ALL 429 of position 1, +13 +17 ALL 400 of position 1, +6 +4 slot 1 ALL 288 of position 2, +63 +25 ALL 287 of position 2, +18 +19 slot 2 ALL 277 of position 3, +45 +28 ALL 272 of position 3, +9 +18 slot 4 ONLY position 4, all 537 ONLY position 4, all 517 slot 5 ONLY position 5, all 182 ONLY position 5, all 179 A slot that accepts every player of one default position and nobody outside a handful of dual-eligible neighbours IS that position's slot. Slots 4 and 5 are decisive on their own - they accept one position and nothing else. And the names land on POSITION_MAPS.fhl's own already-validated labels, derived here from slots rather than from defaultPositionId, so two independent readings agree: that is the cross-check, not a coincidence. The "+13 +17" are the point of the whole entry: players whose default position is winger and who are ALSO eligible at centre. Those are the players the old fallback erased. Slots 3 and 6 are deliberately absent - they are FLEX seats (FLEX_SLOTS.fhl) and appear in FLEX_SLOT_POSITIONS instead. Slot 10 takes a handful of every position and is not a lineup slot either league fields; too few players to name, so it stays unnamed (the ffl rule).
    fhl: { 0: "C", 1: "LW", 2: "RW", 4: "D", 5: "G" }
};

// THE POSITIONS THAT FORM A SPORT'S SECOND RANKING POOL. It was PITCHER_POSITIONS until football arrived and put team defences in it, at which point the name was a lie - and a constant whose name says something the contents contradict is the exact drift the consistency audit exists to catch. The JOB was always general: name the positions that rank apart, whatever the sport calls them. Baseball's pitchers, hockey's goalies, football's defences. Renamed rather than commented around, because the next reader should not have to know the history to trust the table.
export const SECONDARY_GROUP_POSITIONS = {
    flb: new Set(["P", "SP", "RP"]),
    fhl: new Set(["G"]),
    ffl: new Set(["D/ST"])
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
    // statId -> points, per LINEUP SLOT, for leagues whose scoring differs by slot. Football's D/ST ids live here and nowhere else: 20 of that league's 46 scored ids have a base of zero and score only through the slot-16 override.
    scoringSlotWeights: {},
    // The scored ids that belong to the SECONDARY group, derived from the league's own scoring rather than tabled per sport: an id the league scores ONLY in a secondary slot is a secondary-group statistic by the league's own definition. Football's team-defence ids are exactly this shape. Empty for a league whose scoring does not vary by slot, which leaves baseball and hockey on their static role tables untouched.
    secondaryStatIds: new Set(),
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
    // Team breakout tabs: which single team the leaderboard is narrowed to, on top of availability/position/search. kind is 'all' (no breakout), 'fantasy' (id is a fantasy teamId, matches p.teamId) or 'pro' (id is a proTeamId, matches p.proTeamId). Reset to 'all' whenever the availability filter changes (main.js) - the tab SET a selection was made from is different once availability changes (fantasy teams disappear under Free Agents, pro teams disappear under On Teams), so a stale id would silently filter to nothing or, worse, to a different team that happens to share the id space.
    playerBreakoutFilter: { kind: 'all', id: null },
    playerGroup: 'primary',
    showAdvancedStats: false,
    requireMinPlayingTime: true,
    selectedPlayerId: null,
    playerDetailStat: null,
    playerDetailRankPool: 'Overall',
    // The second player in a 1v1 comparison, null whenever the drill-down is showing one player. It is view state rather than a mode flag: set it and the drill-down renders as a comparison, clear it and the same anchor is back on its own page.
    comparePlayerId: null,
    playerDetailRankBreakdownOpen: false,
    // S41/G2: which side of the rank-breakdown bar's Overall|Matchup switch is lit. Only meaningful when the panel actually offers the switch (a league matchup-rank.js can rank this player in) - a league without one never reads it at all, rather than this needing its own guard here.
    playerDetailMatchupSide: 'overall',
    // My Team's "against" comparison. Per-league, not persisted across a league switch (myteam.js clears both on the same key change that resets the viewed team). null opponent means no comparison is shown - a cold session compares nobody, honestly, rather than guessing an opponent.
    myTeamCompareOpponentId: null,
    // S22b: the comparison lives in the same drawer pattern coverage does, never pushing the roster down the page. Choosing an opponent opens it; Close hides it without forgetting the opponent, the same relationship the coverage drawer already has with its own strip.
    myTeamCompareDrawerOpen: false,
    // R5/S29: the coverage drawer's OWN open state, tracked here now that the strip's single control is a real toggle ("Open"/"Close") rather than an open-only button beside the drawer's own X - the label has to survive a re-render (a Window-control click elsewhere on the tab, say) the same way the compare drawer's own flag already does.
    myTeamCoverageDrawerOpen: false,
    // R9/S57: the pitchers' Schedule calendar pages a fixed seven-day window through a longer matchup rather than squeezing every one of its days into the same band (a two-week playoff round used to render fourteen columns, each scrolling inside itself). The window's own START period, or null to mean "the window is not pinned yet - open on whichever one holds today," recomputed fresh every render rather than stored once, so a fresh matchup (or the season rolling into a new one) is never stuck showing a stale week. Set only by the step chevrons; cleared nowhere else, since a null default already re-centers on today automatically.
    myTeamScheduleWindowStart: null,
    playerWeeklyCache: {},
    // O27/S30: ONE shared forward-look field, replacing the leaderboard's own lens and My Team's own compare-window (both removed) - a single choice now drives the leaderboard's window column, My Team's comparison drawer AND its coverage band, made from the tab bar's own Current/Next/Rest-of-season pills rather than three separate per-tab controls that could disagree with each other. null | 'next' | 'rest' - null reads as "this matchup" on the leaderboard/compare drawer and "rest of season at rest" on the coverage band (S28's existing hardcoded behavior, now the explicit null case rather than the only case). Cleared on every fresh league fetch (data.js) since it is tied to THIS league's own matchup structure.
    ahead: null,
    // The Empty Nights measure, decoupled from the window by this same item - a column TOGGLE now, not a fourth window state, so "empty nights across the next matchup" is sayable once ahead and this can vary independently. Scoped to "this matchup" only for now (see players.js's aheadReasons) - extending it to read across Next/Rest too is real future work, not done here.
    showEmptyNights: false,
    // R6/S39: the mock lineup (mock-lineup.js's own state shape, {seats:[{slotId,label, playerId}]}) - built once per league, on the first pre-draft render (graphs.js), since it needs the league's own slot counts to know how many seats exist. null until then, and reset on every league switch (data.js) the same way the other pre-draft-scoped fields are - a mock lineup is a sketch for THIS draft, not a value that should survive into a different league.
    mockLineupState: null,
    // The one seat armed to receive the next Projections row click ("click a seat, then a row") - a seat index into mockLineupState.seats, or null when nothing is targeted. Cleared the same places mockLineupState is.
    mockLineupTarget: null,
    // R1/S47c: which position chip is lit above the mock Projections list ("All", or one eligible position) - 'ALL' shows the whole board. Reset the same places/times mockLineupState is, for the same reason: a filter chosen for one league's own position set means nothing once that state resets to a genuinely different sport or league.
    mockPoolPositionFilter: 'ALL'
};
