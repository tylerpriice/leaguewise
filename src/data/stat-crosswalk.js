/**
 * Which field of an external source carries each ESPN stat id.
 *
 * An external source's field names get the same bar an ESPN stat id does: no row is here on a
 * plausible name. Each was checked against real stat lines from the NHL's own season reports, and
 * where an identity holds across a whole report, such as goals plus assists equalling points, that
 * identity is the check. Save percentage is derived from saves and shots against directly, since
 * shots against less goals against does not equal saves for every goalie.
 *
 * Pure. No DOM, no application state and no network.
 *
 * Tests: tests/features.test.html
 * @module stat-crosswalk
 */
/**
 * How one ESPN stat id is reached in an external source. One of three forms: a field read
 * directly, a value derived from two fields of one report, or a rate left to the app's own rate
 * rules.
 *
 * @typedef {object} ExternalStatSpec
 * @property {string} [report] The report the field is on, a key of NHL_REPORTS.
 * @property {string} [field] The field to read.
 * @property {string[]} [derive] Two fields to compute the value from.
 * @property {string} [op] How to combine them. Only 'subtract' exists.
 * @property {boolean} [components] True for a rate, which is rebuilt from the ids in from.
 * @property {number[]} [from] The ESPN stat ids of the rate's components.
 */

// ==== The reports these fields come from ====

/**
 * The NHL reports the fields come from, by the key each row of the table names. A field name
 * alone does not say which request carries it: one league's categories can need three reports.
 *
 * @type {Object<string, {group: string, report: string}>}
 */
export const NHL_REPORTS = {
    skaterSummary: { group: 'skater', report: 'summary' },
    skaterRealtime: { group: 'skater', report: 'realtime' },
    skaterFaceoffs: { group: 'skater', report: 'faceoffwins' },
    goalieSummary: { group: 'goalie', report: 'summary' }
};

// ==== ESPN stat id to the external field that carries it ====

/**
 * ESPN stat id to the external field that carries it, per sport, in the shape of ESPN_STAT_MAPS.
 * An id with no entry is not scored again from the source; it is not approximated.
 *
 * @type {Object<string, Object<number, ExternalStatSpec>>}
 */
export const EXTERNAL_STAT_FIELDS = {
    fhl: {
        // Skaters, from the summary report. Goals plus assists equals points on every row of it.
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

        // Power-play and short-handed assists are on no report. A power-play point is a power-play goal or a power-play assist and nothing else, so the assists are the points less the goals, and the difference is never negative.
        19: { report: 'skaterSummary', derive: ['ppPoints', 'ppGoals'], op: 'subtract' },
        21: { report: 'skaterSummary', derive: ['shPoints', 'shGoals'], op: 'subtract' },

        // Skaters, from the realtime report. These are not on the summary report, and the two join by player id.
        31: { report: 'skaterRealtime', field: 'hits' },
        32: { report: 'skaterRealtime', field: 'blockedShots' },

        // Skaters, from the faceoff report. The summary report carries only a faceoff percentage, which cannot be scored again; the counts are here.
        23: { report: 'skaterFaceoffs', field: 'totalFaceoffWins' },
        24: { report: 'skaterFaceoffs', field: 'totalFaceoffLosses' },

        // ==== Goalies, from the summary report ====
        0: { report: 'goalieSummary', field: 'gamesStarted' },
        1: { report: 'goalieSummary', field: 'wins' },
        2: { report: 'goalieSummary', field: 'losses' },
        3: { report: 'goalieSummary', field: 'shotsAgainst' },
        4: { report: 'goalieSummary', field: 'goalsAgainst' },
        6: { report: 'goalieSummary', field: 'saves' },
        7: { report: 'goalieSummary', field: 'shutouts' },
        9: { report: 'goalieSummary', field: 'otLosses' },
        // Time on ice in seconds, which is what the goals-against rule's scale of 3600 needs. A per-player average given as minutes and seconds in a string must never be read into this id.
        8: { report: 'goalieSummary', field: 'timeOnIce' },

        // Rates are derived from the components above and never read from the source. Reading the source's own rate would bring in its rounding, and a windowed timeframe sums components and cannot sum an average.
        10: { components: true, from: [4, 8] },   // GAA = GA * 3600 / TOI seconds
        11: { components: true, from: [6, 3] }    // SV% = SV / SA
    },

    // Baseball is empty on purpose. No table is built against a source until that source's terms have been read and recorded.
    flb: {}
};

// ==== What cannot be scored again from the source ====

/**
 * The categories with no external equivalent, per sport, each with the reason, so a page can say
 * a category is not covered and not show a zero.
 *
 * @type {Object<string, Object<number, string>>}
 */
export const UNMAPPED_CATEGORIES = {
    fhl: {
        28: 'Hat tricks have no season field on any NHL surface. They are derivable only by ' +
            'counting games with three or more goals in a player\'s game log, which is one request ' +
            'per player - drill-down scale, not pool-wide.'
    },
    flb: {}
};

// ==== Reading a line ====

/**
 * One ESPN stat id's value from one external row. Null, not zero, for anything the table cannot
 * answer: an unmapped category, a missing field, a value that is not a number. In a
 * lower-is-better category a made-up zero would be the best figure.
 *
 * @param {object} row One row of an external report.
 * @param {string} sport The sport key.
 * @param {string|number} statId The ESPN stat id.
 * @param {object} [fields] The table. Defaults to EXTERNAL_STAT_FIELDS.
 * @returns {?number} The value, or null. A rate reads null here, since it is rebuilt from components.
 */
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

/**
 * An external row as a stat line keyed by ESPN stat id, ready for the rank engine. A rate is not
 * written; its components are, so the app's own rate rules rebuild it.
 *
 * @param {object} row One row of an external report.
 * @param {string} sport The sport key.
 * @param {Array<string|number>} statIds The ESPN stat ids wanted.
 * @param {object} [fields] The table. Defaults to EXTERNAL_STAT_FIELDS.
 * @returns {Object<string, number>} The line. An id with no value is absent.
 */
export function externalLine(row, sport, statIds, fields = EXTERNAL_STAT_FIELDS) {
    const line = {};
    (statIds || []).forEach(id => {
        const spec = ((fields || {})[sport] || {})[String(id)] ?? ((fields || {})[sport] || {})[Number(id)];
        if (!spec) return;
        if (spec.components) {
            // The components are pulled in instead, so the app's rate rules have what they need.
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

/**
 * Which reports a set of categories needs, and which of the categories cannot be covered.
 *
 * @param {string} sport The sport key.
 * @param {Array<string|number>} statIds The ESPN stat ids wanted.
 * @param {object} [fields] The table. Defaults to EXTERNAL_STAT_FIELDS.
 * @returns {{reports: string[], unmapped: string[]}} The report keys, sorted, and the ids with no entry.
 */
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
