// PURE. No DOM, no AppState, no fetches - the same contract as rank-engine.js and its neighbours. --------------------------------------------------------------------------------------------- GOLDEN RULE 4, EXTENDED TO SOMEBODY ELSE'S FIELD NAMES --------------------------------------------------------------------------------------------- state.js's rule is "never guess an ESPN stat id", and every id in it was validated against real stat lines before it shipped. An external source's field names deserve exactly the same bar and get it here: no row below ships on a plausible name. Each was checked against REAL captured stat lines, and the check is written on the row. The captures: the NHL's own season-20242025 bulk reports - skater summary (920 rows), goalie summary (103), skater realtime (920), skater faceoffwins (963 available). Checked. LEAGUE-WIDE IDENTITIES ARE STRONGER THAN ANY SINGLE ANCHOR LINE, so where an identity exists it is the validation, run across the whole dataset rather than against three famous players: goals + assists == points 920/920 exact evGoals + ppGoals + shGoals == goals 920/920 exact evPoints + ppPoints + shPoints == points 920/920 exact (so PPA and SHA subtract exactly) goalsAgainst * 3600 / timeOnIce == GAA 103/103 to 1e-5 (so timeOnIce IS seconds) saves / shotsAgainst == savePct 103/103 to 1e-5 The two rate identities are the ones that mattered most, because RATE_COMPONENTS.fhl already says GAA is GA * 3600 / id-8 and SV% is SV / SA. Those now have their external denominators confirmed rather than assumed - the research plan flagged the time unit specifically, since the per-player landing endpoint serves an "MM:SS" STRING that would silently parse as a small number. ONE IDENTITY DOES NOT HOLD EXACTLY, and it is recorded rather than smoothed: shotsAgainst - goalsAgainst == saves on only 85 of 103 goalies. The other 18 are off by exactly 1 (16 of them) or 2 (2 of them), always with saves HIGHER, which is shootout and empty-net accounting - goals charged where the shots are not. So SV% is derived from saves and shotsAgainst directly, never by reconstructing one of them from the other two.

// ==== The endpoints these fields come from ====

// A field name alone is not enough to fetch anything: hits and blocked shots are not on the same report as goals, and faceoff COUNTS are on a third. Naming the report per row is what stops a caller assuming one request covers a league's categories - for the reference hockey league it takes three.
export const NHL_REPORTS = {
    skaterSummary: { group: 'skater', report: 'summary' },
    skaterRealtime: { group: 'skater', report: 'realtime' },
    skaterFaceoffs: { group: 'skater', report: 'faceoffwins' },
    goalieSummary: { group: 'goalie', report: 'summary' }
};

// ==== ESPN stat id -> the external field that carries it ====

// Keyed by ESPN stat id, mirroring ESPN_STAT_MAPS' shape, so a league's scored ids look this table up directly. Three kinds of entry: { report, field } read it straight { report, derive: [a, b], op } compute it from fields on ONE report (only 'subtract' exists) { components: true } it is a rate; RATE_COMPONENTS already derives it from raw ids this table supplies, so nothing new is invented here An id absent from this table is not externally re-scored. That is the same graceful posture the app already takes with fhl's deliberately unmapped ids, and it is why HAT is absent rather than approximated.
export const EXTERNAL_STAT_FIELDS = {
    fhl: {
        // ---- skaters, summary report ---- Anchored by the league-wide identity 13 + 14 == 16, exact on all 920 rows.
        13: { report: 'skaterSummary', field: 'goals' },
        14: { report: 'skaterSummary', field: 'assists' },
        16: { report: 'skaterSummary', field: 'points' },
        15: { report: 'skaterSummary', field: 'plusMinus' },
        17: { report: 'skaterSummary', field: 'penaltyMinutes' },
        18: { report: 'skaterSummary', field: 'ppGoals' },
        20: { report: 'skaterSummary', field: 'shGoals' },
        22: { report: 'skaterSummary', field: 'gameWinningGoals' },
        29: { report: 'skaterSummary', field: 'shots' },
        38: { report: 'skaterSummary', field: 'ppPoints' },
        39: { report: 'skaterSummary', field: 'shPoints' },

        // POWER-PLAY AND SHORT-HANDED ASSISTS EXIST ON NEITHER SURFACE. They are not missing data: a power-play point is a power-play goal or a power-play assist and nothing else, which is the same 18 + 19 == 38 identity state.js validated on all 942 ESPN skaters. Confirmed from the other side too - evPoints + ppPoints + shPoints == points on all 920 rows, and ppPoints >= ppGoals on every one of them, so the subtraction is never negative.
        19: { report: 'skaterSummary', derive: ['ppPoints', 'ppGoals'], op: 'subtract' },
        21: { report: 'skaterSummary', derive: ['shPoints', 'shGoals'], op: 'subtract' },

        // ---- skaters, realtime report ---- Not on the summary report at all. Joins to it by playerId - checked, 920 of 920 skaters present on both.
        31: { report: 'skaterRealtime', field: 'hits' },
        32: { report: 'skaterRealtime', field: 'blockedShots' },

        // ---- skaters, faceoffwins report ---- A THIRD report, and the casing is not what the plan predicted. The summary report carries only faceoffWinningPctg, a percentage, which cannot be re-scored; the counts live here. The plan wrote these as totalFaceOffWins/Losses with a capital O and flagged the casing for verification - the capture says lowercase: totalFaceoffWins, totalFaceoffLosses. Verifying it was the difference between a working column and an undefined one.
        23: { report: 'skaterFaceoffs', field: 'totalFaceoffWins' },
        24: { report: 'skaterFaceoffs', field: 'totalFaceoffLosses' },

        // ---- goalies, summary report ----
        0: { report: 'goalieSummary', field: 'gamesStarted' },
        1: { report: 'goalieSummary', field: 'wins' },
        2: { report: 'goalieSummary', field: 'losses' },
        3: { report: 'goalieSummary', field: 'shotsAgainst' },
        4: { report: 'goalieSummary', field: 'goalsAgainst' },
        6: { report: 'goalieSummary', field: 'saves' },
        7: { report: 'goalieSummary', field: 'shutouts' },
        9: { report: 'goalieSummary', field: 'otLosses' },
        // Time on ice in SECONDS, which is what RATE_COMPONENTS' scale of 3600 needs and what the GAA identity above confirms to 1e-5 on every goalie. The landing endpoint's avgToi is an "MM:SS" string and must never be read into this id.
        8: { report: 'goalieSummary', field: 'timeOnIce' },

        // ---- rates: derived from the components above, never read from the source ---- The house rule: a team rate is its components summed and the formula then applied. Reading the source's own GAA would also mean importing its rounding - measured at 1e-5 against the exact derivation - and would break every windowed timeframe, which sums components and cannot sum an average.
        10: { components: true, from: [4, 8] },   // GAA = GA * 3600 / TOI seconds
        11: { components: true, from: [6, 3] }    // SV% = SV / SA
    },

    // BASEBALL IS DELIBERATELY EMPTY, for the same reason player-id-map.js's club table is: MLBAM's terms restrict commercial use, and DATA-SOURCES #2 wants that check read and recorded before anything is built against that host.
    flb: {}
};

// ==== What cannot be re-scored, said out loud ====

// A category with no external equivalent is NOT approximated. Naming it here, with the reason, is what lets a surface tell a reader "this one is not covered" instead of showing them a zero.
export const UNMAPPED_CATEGORIES = {
    fhl: {
        28: 'Hat tricks have no season field on any NHL surface. They are derivable only by ' +
            'counting games with three or more goals in a player\'s game log, which is one request ' +
            'per player - drill-down scale, not pool-wide.'
    },
    flb: {}
};

// ==== Reading a line ====

// One external row, one ESPN stat id, out comes the value - or null. NULL, NOT ZERO, for anything this table cannot answer: an unmapped category, a field the row does not carry, a non-numeric value. Zero is a claim that the player did none of it, and in an inverse category zero is the BEST possible figure, so a fabricated zero does not merely lose information, it hands out an undeserved win. Same unknown-is-not-zero rule the rank engine and the draft board already hold to.
export function externalValue(row, sport, statId, fields = EXTERNAL_STAT_FIELDS) {
    const spec = ((fields || {})[sport] || {})[String(statId)] ?? ((fields || {})[sport] || {})[Number(statId)];
    if (!spec || !row || spec.components) return null;
    const num = key => {
        const v = row[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    if (spec.derive) {
        const a = num(spec.derive[0]);
        const b = num(spec.derive[1]);
        if (a === null || b === null) return null;
        return spec.op === 'subtract' ? a - b : null;
    }
    return num(spec.field);
}

// A whole external row rendered as an ESPN-shaped stat line, ready for the rank engine. Rates are NOT written here even though this table knows how to reach them: they are rebuilt from these raw components by the app's existing RATE_COMPONENTS derivation, which is the one place that arithmetic is allowed to live. Writing a rate here would be a second copy of it.
export function externalLine(row, sport, statIds, fields = EXTERNAL_STAT_FIELDS) {
    const line = {};
    (statIds || []).forEach(id => {
        const spec = ((fields || {})[sport] || {})[String(id)] ?? ((fields || {})[sport] || {})[Number(id)];
        if (!spec) return;
        if (spec.components) {
            // Pull the components in instead, so RATE_COMPONENTS has what it needs downstream.
            (spec.from || []).forEach(cid => {
                const v = externalValue(row, sport, cid, fields);
                if (v !== null) line[cid] = v;
            });
            return;
        }
        const v = externalValue(row, sport, id, fields);
        if (v !== null) line[id] = v;
    });
    return line;
}

// Which reports a league's scored categories actually require, and which of them cannot be covered at all. A caller planning requests asks this rather than guessing that one report is enough.
export function reportsFor(sport, statIds, fields = EXTERNAL_STAT_FIELDS) {
    const table = (fields || {})[sport] || {};
    const reports = new Set();
    const unmapped = [];
    (statIds || []).forEach(id => {
        const spec = table[String(id)] ?? table[Number(id)];
        if (!spec) { unmapped.push(String(id)); return; }
        if (spec.components) {
            (spec.from || []).forEach(cid => {
                const inner = table[String(cid)] ?? table[Number(cid)];
                if (inner && inner.report) reports.add(inner.report);
            });
            return;
        }
        if (spec.report) reports.add(spec.report);
    });
    return { reports: [...reports].sort(), unmapped };
}
