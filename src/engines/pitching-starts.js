/**
 * Quality starts, and the ones narrowly missed: a blown quality start is a stat of this app's own,
 * since ESPN keeps none.
 *
 * A start arrives as its outs and its earned runs. Reading those out of an ESPN stat line is the
 * caller's, with validated stat ids, so this module holds no stat id. The quality start here
 * equals ESPN's own per-day flag on every start of a full season measured.
 *
 * Pure. No DOM, no application state and no network.
 *
 * Contract: tests/fixtures/pitching-starts.md
 * Tests: tests/pitching-starts.test.html
 * @module pitching-starts
 */
/**
 * One start, by its totals.
 *
 * @typedef {object} StartLine
 * @property {number} outs The outs recorded. Eighteen is six innings.
 * @property {number} earnedRuns The earned runs allowed.
 */

// A line is read only when both figures are numbers. A number sent as text is refused too, since a guessed zero would turn an unread line into a shutout.
function readable(line) {
    return !!line
        && typeof line.outs === 'number' && Number.isFinite(line.outs) && line.outs >= 0
        && typeof line.earnedRuns === 'number' && Number.isFinite(line.earnedRuns) && line.earnedRuns >= 0;
}

/**
 * Whether a start is a quality start: at least six innings, which is 18 outs, with three or fewer
 * earned runs.
 *
 * @param {StartLine} line The start.
 * @returns {?boolean} True or false, or null for a line that cannot be read.
 */
export function qualityStart(line) {
    if (!readable(line)) return null;
    return line.outs >= 18 && line.earnedRuns <= 3;
}

/**
 * Whether a start fell one inning short of a quality start, and how: 15 to 17 outs with three or
 * fewer earned runs is 'hook', and with exactly four is 'runs'. Eighteen or more outs with four
 * runs is neither a quality start nor a blown one.
 *
 * A total cannot say when the fourth run came, so 'runs' is every such start with exactly four.
 *
 * @param {StartLine} line The start.
 * @returns {?('hook'|'runs')} The kind, or null for a start that is not a blown quality start or cannot be read.
 */
export function blownQualityStart(line) {
    if (!readable(line)) return null;
    if (line.outs < 15 || line.outs > 17) return null;
    if (line.earnedRuns <= 3) return 'hook';
    if (line.earnedRuns === 4) return 'runs';
    return null;
}

/**
 * Counts a set of starts, each once and in at most one bucket. Starts that cannot be read are
 * counted and not dropped, so the figures say how many starts they cover.
 *
 * @param {StartLine[]} lines The starts.
 * @returns {{starts: number, quality: number, blown: number, blownHook: number, blownRuns: number, neither: number, unread: number}} The counts. Neither is 18 or more outs with exactly four earned runs.
 */
export function startsSummary(lines) {
    const out = { starts: 0, quality: 0, blown: 0, blownHook: 0, blownRuns: 0, neither: 0, unread: 0 };
    (Array.isArray(lines) ? lines : []).forEach(line => {
        out.starts += 1;
        if (!readable(line)) { out.unread += 1; return; }
        if (qualityStart(line)) { out.quality += 1; return; }
        const blown = blownQualityStart(line);
        if (blown === 'hook') { out.blownHook += 1; return; }
        if (blown === 'runs') { out.blownRuns += 1; return; }
        if (line.outs >= 18 && line.earnedRuns === 4) out.neither += 1;
    });
    out.blown = out.blownHook + out.blownRuns;
    return out;
}
