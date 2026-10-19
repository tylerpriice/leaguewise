/**
 * Shared helpers for the dashboard. Stat id role ordering, matchup tallies and timeframe parsing, the
 * scoring period to matchup map, tooltip wiring, the diagnostic panel's capture store and zip download,
 * the league view registry, season year lists, the request tally and team identity lookups.
 *
 * It reads the shared application state, and touches the DOM only in the tooltip, diagnostic panel and
 * reveal helpers. The matchup and timeframe math is pure.
 * @module utils
 *
 * @typedef {Object} MatchupPeriodMap
 * @property {Map<number, number>} byPeriod Scoring period to the matchup that period belongs to.
 * @property {number} lastPeriod The highest scoring period any matchup has scored.
 * @property {number} lastMatchup The highest matchup number that has a scored day.
 * @property {number} currentMatchup The matchup being played, 0 when the payload does not say.
 * @property {Map<number, number>} weeksByMatchup How many weeks each matchup holds, from the league settings.
 * @property {number} finalPeriod The league's last scoring period, 0 when unknown.
 * @property {{start: number, end: number}|null} currentSpan The first and last day of the matchup being played.
 */
import { AppState, PITCHING_IDS, GOALIE_IDS, ESPN_STAT_MAPS, ESPN_STAT_FULL_NAMES, SPORT_NAMES } from '../data/state.js';
import { buildZip } from '../data/zip.js';
import { draftPickOf } from '../engines/preseason-face.js';
import { recordRequest } from '../data/request-log.js';
import { roomSnapshotExport } from '../data/room-feed.js';
import { buildCaptureIndex } from '../data/capture-all.js';

// Partitions a stat id list by role so batting comes before pitching and skaters before goalies. The partition is stable, so the caller's own order survives inside each group.
const ROLE_ID_SETS = { flb: PITCHING_IDS, fhl: GOALIE_IDS };
/**
 * The set of stat ids that form a sport's second role group (pitching, goalies), as strings.
 *
 * @type {function(string): Set<string>}
 * @param {string} sport The sport key.
 * @returns {Set<string>} The role's stat ids; the league's own secondary ids when the sport has no static table, else an empty set.
 */
export const roleIdSetFor = (sport) => ROLE_ID_SETS[sport] || AppState.secondaryStatIds || new Set();

/**
 * Splits a list of stat ids into the primary role and the secondary role, keeping the input order within each.
 *
 * @param {string} sport The sport key.
 * @param {Array<string|number>} statIds Stat ids as strings or numbers.
 * @returns {{primary: Array<string|number>, secondary: Array<string|number>}} The two groups.
 */
export function splitStatIdsByRole(sport, statIds) {
    const secondaryIds = roleIdSetFor(sport);
    const primary = [], secondary = [];
    statIds.forEach(id => {
        // Callers pass ids as strings or as numbers, while the role sets are keyed by string.
        if (secondaryIds && secondaryIds.has(String(id))) secondary.push(id);
        else primary.push(id);
    });
    return { primary, secondary };
}

/**
 * Orders stat ids with the primary role first and the secondary role after it.
 *
 * @param {string} sport The sport key.
 * @param {Array<string|number>} statIds Stat ids as strings or numbers.
 * @returns {Array<string|number>} The same ids, role-grouped and otherwise in input order.
 */
export function orderStatIdsByRole(sport, statIds) {
    const { primary, secondary } = splitStatIdsByRole(sport, statIds);
    return [...primary, ...secondary];
}

/**
 * Unwraps a stat value that ESPN sometimes sends as `{value: X}` instead of a raw number.
 *
 * @param {*} v A raw number, a `{value}` object, null or undefined.
 * @returns {*} The inner value for an object, otherwise the input unchanged.
 */
export function statValue(v) {
    return (v && typeof v === 'object') ? v.value : v;
}

/**
 * Turns a stat value into a number, mapping ESPN's string "Infinity" to real Infinity and anything unreadable to null.
 *
 * @param {*} v A raw stat value, possibly a `{value}` object or a numeric string.
 * @returns {number|null} The number, or null where there is no value.
 */
export function numericStat(v) {
    const raw = statValue(v);
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
}

/**
 * Unwraps every value of a raw stats map with statValue.
 *
 * @param {Object<string, *>} rawStats Stat id to raw value; null is treated as empty.
 * @returns {Object<string, *>} A new map with each value unwrapped.
 */
export function unwrapStats(rawStats) {
    const result = {};
    Object.keys(rawStats || {}).forEach(id => { result[id] = statValue(rawStats[id]); });
    return result;
}

/**
 * Returns the first argument that is not undefined.
 *
 * @param {...*} values Candidate values in order of preference.
 * @returns {*} The first defined value, or undefined when there is none.
 */
export function firstDefined(...values) {
    return values.find(v => v !== undefined);
}

/**
 * Picks the live tally block of a matchup side when ESPN has attached one, otherwise the finalized-days rollup.
 *
 * @param {Object|null} side One side of a schedule game.
 * @returns {Object|null} The tally carrying `wins`, `losses`, `ties` and `scoreByStat`, or null for a missing side.
 */
export function matchupTally(side) {
    if (!side) return null;
    const live = side.cumulativeScoreLive;
    // A numeric `wins` is the test, since an empty object would otherwise shadow a good rollup.
    if (live && typeof live.wins === 'number') return live;
    return side.cumulativeScore || null;
}

/**
 * Reads a side's points total, preferring the live figure over the finalized one.
 *
 * @param {Object|null} side One side of a schedule game.
 * @returns {number} The points, or 0 when there are none.
 */
export function matchupPoints(side) {
    if (!side) return 0;
    const live = side.totalPointsLive;
    return (typeof live === 'number' ? live : side.totalPoints) || 0;
}

/**
 * Says whether a matchup week is one the schedule reader should take, meaning scored or being played right now.
 *
 * @param {number} week The matchup number.
 * @param {number} maxCompletedWeek The last matchup with a result.
 * @param {number} currentMatchup The matchup being played, 0 once the season is over.
 * @returns {boolean} True when the week is at or before the later of the last two.
 */
export function readsAsPlayedMatchup(week, maxCompletedWeek, currentMatchup) {
    return week <= Math.max(maxCompletedWeek || 0, currentMatchup || 0);
}

/**
 * Gives one side's result for a game, or null while the winner is undecided.
 *
 * @param {Object|null} game A schedule game with a `winner` of 'HOME', 'AWAY' or 'TIE'.
 * @param {string} side 'home' or 'away'.
 * @returns {number|null} 1 for a win, 0.5 for a tie, 0 for a loss, null when there is no result yet.
 */
export function matchResultOf(game, side) {
    if (!game || !game[side]) return null;
    const winner = game.winner;
    if (winner === 'TIE') return 0.5;
    if (winner !== 'HOME' && winner !== 'AWAY') return null;
    return winner === side.toUpperCase() ? 1 : 0;
}

/**
 * Reads one side's per-category values for a matchup from the same tally the header uses.
 *
 * @param {Object|null} side One side of a schedule game.
 * @returns {Object<string, number>} Stat id to value; empty when the side carries no tally.
 */
export function matchupCatsForSide(side) {
    const tally = matchupTally(side);
    const statsObj = (tally && (tally.scoreByStat || tally.statBySlot)) || {};
    const out = {};
    for (const key in statsObj) {
        const statData = statsObj[key];
        const sId = statData.statId !== undefined ? statData.statId.toString() : key;
        out[sId] = numericStat(firstDefined(statData.score, statData.value)) || 0;
    }
    return out;
}

/**
 * Splits stat ids into the ones this league scores and the rest ESPN tracks.
 *
 * @param {Array<string|number>} ids The stat ids to split.
 * @param {Set<*>} [forceScored] Ids to treat as scored even when the league's scoring items do not list them.
 * @returns {{scored: Array, advanced: Array}} Both groups; everything is scored when the league's settings match none.
 */
export function splitScoredAdvanced(ids, forceScored = new Set()) {
    if (AppState.scoredStatIds.size === 0) return { scored: ids, advanced: [] };

    const scored = ids.filter(id => AppState.scoredStatIds.has(id.toString()) || forceScored.has(id));
    // When no id matches the scored set, everything is shown rather than an empty list.
    if (scored.length === 0) return { scored: ids, advanced: [] };

    const scoredSet = new Set(scored);
    return { scored, advanced: ids.filter(id => !scoredSet.has(id)) };
}

/**
 * Lists the categories the Category Rankings pager cycles through, role-grouped and de-duplicated by name.
 *
 * @param {string} sport The sport key.
 * @returns {Array<{id: (string|number), name: string}>} The scored categories, plus the advanced ones when advanced stats are on.
 */
export function categoryCycleList(sport) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const all = [];
    const seenNames = new Set();
    Array.from(AppState.availableStatsSet).forEach(statId => {
        const name = statMap[statId] || `Stat [${statId}]`;
        if (seenNames.has(name)) return;
        seenNames.add(name);
        all.push({ id: statId, name });
    });
    if (all.length === 0) return [];

    const { scored, advanced } = splitScoredAdvanced(all.map(s => s.id));
    const visible = new Set(AppState.showAdvancedStats ? [...scored, ...advanced] : scored);
    const byId = new Map(all.map(s => [String(s.id), s]));
    const shown = all.filter(s => visible.has(s.id));
    const { primary, secondary } = splitStatIdsByRole(sport, shown.map(s => s.id));
    return [...primary, ...secondary].map(id => byId.get(String(id))).filter(Boolean);
}

/**
 * Names the time-axis unit for the loaded league type, matchups for head-to-head and weeks for roto.
 *
 * @returns {{short: string, long: string, plural: string}} The three spellings of the unit.
 */
export function axisUnit() {
    return AppState.isRotoLeague
        ? { short: 'WK', long: 'Week', plural: 'Weeks' }
        : { short: 'M', long: 'Matchup', plural: 'Matchups' };
}

// Maps ESPN's scoringType to the label and tooltip the top bar shows. It is plain data so every label can be asserted without rendering anything.
const SCORING_TYPE_BADGES = {
    H2H_EACH_CATEGORY: {
        label: 'Weekly H2H · Categories',
        tooltip: 'Weekly head-to-head, each category its own win or loss. A matchup can end in a tie if the categories split evenly.',
    },
    H2H_MOST_CATEGORIES: {
        label: 'Weekly H2H · Most Categories',
        tooltip: 'Weekly head-to-head. The week goes to whichever team wins more categories.',
    },
    H2H_POINTS: {
        label: 'Weekly H2H · Points',
        tooltip: 'Weekly head-to-head on total points scored.',
    },
    ROTO: {
        label: 'Roto · Season Categories',
        tooltip: 'Rotisserie. Teams accumulate category totals across the whole season, and standings are the sum of each category\'s own rank.',
    },
    TOTAL_SEASON_POINTS: {
        label: 'Season Points',
        tooltip: 'Season-long points with no weekly matchups. Standings are the running point total.',
    },
};

/**
 * Looks up the label and tooltip that name a league's scoring format in the top bar.
 *
 * @param {string} [type] ESPN's scoringType.
 * @returns {{label: string, tooltip: string}|null} The badge, the raw type as its own label when unrecognized, or null when absent.
 */
export function leagueTypeBadge(type) {
    if (!type) return null;
    const known = SCORING_TYPE_BADGES[type];
    if (known) return known;
    return { label: type, tooltip: `An ESPN scoring format this app does not yet have a name for (${type}).` };
}

// The draft's own format as a proper noun. Shared so the draft tab and the countdown card cannot drift apart. An enum this table does not name is shown as itself, lowercased and spaced.
const DRAFT_TYPE_LABELS = { SNAKE: 'Snake Draft', AUCTION: 'Auction Draft', OFFLINE: 'Offline Draft', AUTOPICK: 'Autopick' };
/**
 * Names a draft format as a proper noun, such as "Snake Draft".
 *
 * @param {string} [type] ESPN's draft type.
 * @returns {string|null} The label, a lowercased and spaced form of an unrecognized type, or null when absent.
 */
export function draftTypeLabel(type) {
    const key = String(type || '').toUpperCase();
    if (!key) return null;
    return DRAFT_TYPE_LABELS[key] || key.replace(/_/g, ' ').toLowerCase();
}

/**
 * Builds a category header as the abbreviation followed by its spelled-out name.
 *
 * @param {string} sport The sport key.
 * @param {string|number} statId The stat id.
 * @param {string} shortName The abbreviation shown elsewhere in the app.
 * @returns {string} "W (Wins)" style text, or the abbreviation alone when no expansion is documented.
 */
export function categoryHeaderLabel(sport, statId, shortName) {
    const full = (ESPN_STAT_FULL_NAMES[sport] || {})[statId];
    return (!full || full === shortName) ? shortName : `${shortName} (${full})`;
}

/**
 * Counts the categories the Advanced Stats toggle would add.
 *
 * @param {string} sport The sport key.
 * @returns {number} The number of tracked categories the league does not score; zero means the toggle has nothing to offer.
 */
export function advancedCategoryCount(sport) {
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const ids = [];
    const seenNames = new Set();
    Array.from(AppState.availableStatsSet).forEach(statId => {
        const name = statMap[statId] || `Stat [${statId}]`;
        if (seenNames.has(name)) return;
        seenNames.add(name);
        ids.push(statId);
    });
    return splitScoredAdvanced(ids).advanced.length;
}

/**
 * Computes a bar's fill percentage against a zoomed baseline that sits 15 percent of the range below the minimum.
 *
 * @param {number} val The value being drawn.
 * @param {number} min The smallest value in the set.
 * @param {number} max The largest value in the set.
 * @returns {number} A fill from 0 upward, 100 at the maximum.
 */
export function getZoomedFillPct(val, min, max) {
    if (min === max) return val > 0 ? 100 : 0;
    const range = max - min;
    let baseline = min - (range * 0.15);
    if (min >= 0 && baseline < 0) baseline = 0;
    const adjustedMax = max - baseline;
    if (adjustedMax === 0) return 0;
    return Math.max(0, ((val - baseline) / adjustedMax) * 100);
}

/**
 * Parses a shared timeframe value into its span, lookback window and picked matchup.
 *
 * @param {string} [tfVal] A value such as "all", "reg+last4" or "p_all+m3"; a bare "lastN" is read as a full-season lookback.
 * @returns {{span: string, window: (number|null), matchup: (number|null)}} The parts; a picked matchup also reports a window of 1.
 */
export function parseTimeframe(tfVal) {
    const parts = String(tfVal || 'all').split('+');
    const head = parts[0];
    const readTail = (tail) => {
        if (!tail) return { window: null, matchup: null };
        if (tail.startsWith('last')) return { window: parseInt(tail.slice(4), 10) || null, matchup: null };
        if (tail.startsWith('m')) {
            const m = parseInt(tail.slice(1), 10);
            return Number.isFinite(m) && m > 0 ? { window: 1, matchup: m } : { window: null, matchup: null };
        }
        return { window: null, matchup: null };
    };
    if (head.startsWith('last')) return { span: 'all', window: parseInt(head.slice(4), 10) || null, matchup: null };
    return { span: head, ...readTail(parts[1]) };
}

/**
 * Spells a timeframe value from its parts, the inverse of parseTimeframe.
 *
 * @param {string} span The span key, "all" when empty.
 * @param {Object} [tail] The optional tail; a matchup wins over a window.
 * @param {number|null} [tail.window] The lookback size.
 * @param {number|null} [tail.matchup] The picked matchup number.
 * @returns {string} The timeframe value.
 */
export function timeframeValueFor(span, { window = null, matchup = null } = {}) {
    const base = span || 'all';
    if (matchup) return `${base}+m${matchup}`;
    if (window) return `${base}+last${window}`;
    return base;
}

/**
 * Finds the first and last matchup the stepper may stop on inside a span.
 *
 * @param {string} span The span key ('all', 'reg' or 'p_all').
 * @param {number} maxWk The last matchup with a score.
 * @param {number} regWks The number of regular-season matchups.
 * @param {number} [currentWk] The matchup being played.
 * @returns {{first: (number|null), last: (number|null), live: (number|null)}} All null when the span holds no started matchup.
 */
export function matchupRangeFor(span, maxWk, regWks, currentWk = 0) {
    const max = Number(maxWk) || 0;
    const reg = Number(regWks) || 0;
    const live = Number(currentWk) || 0;
    const started = (live === max + 1) ? live : max;
    const first = span === 'p_all' ? reg + 1 : 1;
    const last = span === 'reg' ? Math.min(started, reg) : started;
    if (!last || last < first) return { first: null, last: null, live: null };
    return { first, last, live: live >= first && live <= last ? live : null };
}

/**
 * Names where a matchup stands, as live, final or future.
 *
 * @param {number} matchup The matchup number.
 * @param {number} maxWk The last matchup with a score.
 * @param {number} [currentWk] The matchup being played.
 * @returns {'live'|'final'|'future'|null} The state, or null for no matchup.
 */
export function matchupStateOf(matchup, maxWk, currentWk = 0) {
    const m = Number(matchup) || 0;
    const max = Number(maxWk) || 0;
    const live = Number(currentWk) || 0;
    if (!m) return null;
    if (m === live && m >= max) return 'live';
    return m <= max ? 'final' : 'future';
}

/**
 * Labels the dates a matchup ran, as one date or a range of days.
 *
 * @param {Array<number>} periods The scoring periods of the matchup.
 * @param {Map<number, number>|Object<string, number>} datesByPeriod Scoring period to a timestamp.
 * @returns {string|null} The label, or null when no period carries a date.
 */
export function matchupDateLabel(periods, datesByPeriod) {
    return dateRangeLabel((periods || [])
        .map(p => datesByPeriod && (datesByPeriod.get ? datesByPeriod.get(Number(p)) : datesByPeriod[p])));
}

/**
 * Labels the range covered by a list of timestamps, with one date when they fall on a single day.
 *
 * @param {Array<number|null|undefined>} list Timestamps in milliseconds; null and undefined are dropped.
 * @returns {string|null} The label, or null when the list holds no usable timestamp.
 */
export function dateRangeLabel(list) {
    // Null and undefined are dropped before Number(), which would turn a null into the epoch.
    const stamps = (list || []).filter(v => v !== null && v !== undefined)
        .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!stamps.length) return null;
    const first = new Date(stamps[0]);
    const last = new Date(stamps[stamps.length - 1]);
    const month = (d) => d.toLocaleDateString(undefined, { month: 'short' });
    const dayOf = (d) => d.getDate();
    if (stamps.length === 1 || (first.getMonth() === last.getMonth() && dayOf(first) === dayOf(last))) {
        return `${month(first)} ${dayOf(first)}`;
    }
    return first.getMonth() === last.getMonth()
        ? `${month(first)} ${dayOf(first)} - ${dayOf(last)}`
        : `${month(first)} ${dayOf(first)} - ${month(last)} ${dayOf(last)}`;
}

/**
 * Chooses the lookback window sizes from the length of the regular season.
 *
 * @param {number} regWks The number of regular-season matchups.
 * @returns {number[]} [6, 4, 2] for a season of 14 matchups or fewer, otherwise [12, 8, 4].
 */
export function timeframeWindowSizes(regWks) {
    return (Number(regWks) || 0) <= 14 ? [6, 4, 2] : [12, 8, 4];
}

/**
 * Resolves a timeframe value into a first and last matchup.
 *
 * @param {string} tfVal The shared timeframe value.
 * @param {number} maxWk The last matchup with a score.
 * @param {number} regWks The number of regular-season matchups.
 * @param {number} [currentWk] The matchup being played.
 * @returns {{start: number, end: number}} The inclusive matchup range.
 */
export function getTimeframeBounds(tfVal, maxWk, regWks, currentWk = 0) {
    const { span, window: n, matchup } = parseTimeframe(tfVal);

    let start = 1;
    let end = maxWk;
    if (span === 'reg') end = Math.min(maxWk, regWks);
    else if (span === 'p_all') start = regWks + 1;

    // A picked matchup is read inside the span it was picked in, so a value carried across a span change lands on the nearest matchup that span holds.
    if (matchup) {
        const range = matchupRangeFor(span, maxWk, regWks, currentWk);
        if (range.last) {
            const at = Math.min(Math.max(matchup, range.first), range.last);
            return { start: at, end: at };
        }
        return { start, end };
    }

    if (n) {
        // The live matchup only extends a span that contains it, so "Current" inside the regular season stays on its last matchup on the morning a playoff matchup starts.
        const spanHoldsLive = span === 'reg' ? currentWk <= regWks : true;
        if (n === 1 && spanHoldsLive && currentWk === maxWk + 1) end = currentWk;
        start = Math.max(start, end - n + 1);
    }
    return { start, end };
}

/**
 * Rounds a chart's maximum up to a value that divides evenly into four gridlines.
 *
 * @param {number} val The largest value drawn.
 * @returns {number} The axis maximum; 4 for a value of zero or less.
 */
export function getNiceMax(val) {
    if (val <= 0) return 4;
    if (val >= 4) {
        let step = Math.ceil(val / 4);
        if (step > 10) step = Math.ceil(step / 5) * 5;
        return step * 4;
    }
    // A value under 4 would otherwise floor to a fixed max of 4 and squash a rate chart, so the step scales down by powers of 10 instead.
    let unit = 1;
    while (val < unit) unit /= 10;
    const step = Math.ceil(val / (unit / 4) + 0.5);
    return step * (unit / 4);
}

// Lightens (positive percent) or darkens (negative percent) a hex color.
function shadeColor(hex, percent) {
    const f = parseInt(hex.slice(1), 16);
    const t = percent < 0 ? 0 : 255;
    const p = Math.abs(percent) / 100;
    const R = f >> 16, G = (f >> 8) & 0x00FF, B = f & 0x0000FF;
    const toHex = (c) => Math.max(0, Math.min(255, Math.round((t - c) * p) + c)).toString(16).padStart(2, '0');
    return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
}

/**
 * Clamps a percentile to 0 through 100 so it can be handed to the stylesheet as a number.
 *
 * @param {*} pct The percentile.
 * @returns {number} The clamped number, 0 when it is not numeric.
 */
export function percentileVar(pct) {
    return Math.max(0, Math.min(100, Number(pct) || 0));
}

/**
 * Reads which bracket tier a team's week belonged to.
 *
 * @param {Object} team A team stats row with a `weeklyTier` map.
 * @param {number} week The matchup number.
 * @returns {string} 'reg', 'playoff' or 'consolation'; 'reg' when unrecorded.
 */
export function getWeekTier(team, week) {
    return team.weeklyTier?.[week] || 'reg';
}

/**
 * Darkens a base color for a playoff week and lightens it for a consolation week.
 *
 * @param {string} tier 'reg', 'playoff' or 'consolation'.
 * @param {string} baseColor A hex color such as "#336699".
 * @returns {string} The adjusted hex color.
 */
export function tierColor(tier, baseColor) {
    if (tier === 'playoff') return shadeColor(baseColor, -25);
    if (tier === 'consolation') return shadeColor(baseColor, 45);
    return baseColor;
}

/**
 * Splits a per-week value series into regular-season, playoff and consolation parts.
 *
 * @param {Object} team A team stats row with a `weeklyTier` map.
 * @param {number} startWeek The first matchup.
 * @param {number} endWeek The last matchup.
 * @param {function(number): number} getWeekVal Reads the value for one matchup.
 * @returns {{reg: number, playoff: number, consolation: number, total: number}} The three parts and their sum.
 */
export function splitByTier(team, startWeek, endWeek, getWeekVal) {
    let reg = 0, playoff = 0, consolation = 0;
    for (let w = startWeek; w <= endWeek; w++) {
        const val = getWeekVal(w) || 0;
        const tier = getWeekTier(team, w);
        if (tier === 'playoff') playoff += val;
        else if (tier === 'consolation') consolation += val;
        else reg += val;
    }
    return { reg, playoff, consolation, total: reg + playoff + consolation };
}

// ESPN's injuryStatus tokens mapped to plain words. The tokens were counted in real captures; the key still says DL where the label says IL.
const INJURY_STATUS_LABELS = {
    DAY_TO_DAY: 'Day to day',
    SEVEN_DAY_DL: 'On the 7-day IL',
    TEN_DAY_DL: 'On the 10-day IL',
    FIFTEEN_DAY_DL: 'On the 15-day IL',
    SIXTY_DAY_DL: 'On the 60-day IL',
    OUT: 'Out',
    INJURY_RESERVE: 'On injured reserve',
    SUSPENSION: 'Suspended'
};

// Day to day is the only status in the validated set where the player is likely to play anyway, so it is the only one that reads amber. Everything else means unavailable and reads red.
const INJURY_MINOR = new Set(['DAY_TO_DAY']);

// A suspension is not an injury. It still belongs on this badge, because what the badge answers is "can I count on this player", but it gets its own glyph so the icon never claims an injury that did not happen.
function injuryGlyph(status) {
    return status === 'SUSPENSION' ? '!' : '✚';
}

/**
 * Maps ESPN's injuryStatus to the words a person would use.
 *
 * @param {string} [status] ESPN's injury status token.
 * @returns {string} The label, a titlecased form of an unknown token, or an empty string for a healthy player.
 */
export function injuryLabel(status) {
    if (!status || status === 'ACTIVE') return '';
    return INJURY_STATUS_LABELS[status]
        || String(status).toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

/**
 * Builds the availability badge shared by the leaderboard, the roster and the drill-down.
 *
 * @param {string} [status] ESPN's injury status token.
 * @returns {string} The badge markup, or an empty string for a healthy player.
 */
export function injuryBadgeHtml(status) {
    const label = injuryLabel(status);
    if (!label) return '';
    const tier = INJURY_MINOR.has(status) ? 'minor' : 'major';
    return `<span class="injury-icon injury-${tier}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${injuryGlyph(status)}</span>`;
}

/**
 * Gives the one sentence every surface shows when the player pool is missing.
 *
 * @param {Error & {authRequired?: boolean}} [err] The failure; `authRequired` marks a logged-out session.
 * @returns {string} Plain text that the caller must escape.
 */
export function playerPoolErrorText(err) {
    if (err && err.authRequired) return 'Log into ESPN in this browser to load player data, then refresh.';
    return `Couldn't load player data: ${(err && err.message) || 'Unknown error'}`;
}

/**
 * Escapes the five HTML-significant characters, including the single quote.
 *
 * @param {*} str The value to escape; it is converted to a string first.
 * @returns {string} Text that is safe in element content and in quoted attributes.
 */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Builds the shared loading state, one mark and one word everywhere the app is waiting.
 *
 * @returns {string} The loading markup.
 */
export function buildLoadingHtml() {
    return `<div class="loading-state"><span class="loading-icon" aria-hidden="true"></span><span class="loading-text">Loading</span></div>`;
}

function ensureFloatingTooltip() {
    let el = document.getElementById('floating-tooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'floating-tooltip';
        el.style.cssText = 'position:fixed; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:8px 12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:normal; max-width:360px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(el);
    }
    return el;
}

/**
 * Lays out a chart hover tooltip's rows so a large league cannot clip, then positions it near the cursor inside the viewport.
 *
 * @param {HTMLElement} tooltipEl A position-fixed tooltip holding a `.tt-rows` wrapper and an optional `.tt-header`.
 * @param {number} clientX The cursor's viewport x.
 * @param {number} clientY The cursor's viewport y.
 */
export function layoutHoverTooltip(tooltipEl, clientX, clientY) {
    const rowsEl = tooltipEl.querySelector('.tt-rows');
    // Every measurement starts from the natural single column, since an earlier mousemove may have left a grid reflow.
    if (rowsEl) {
        rowsEl.style.display = '';
        rowsEl.style.gridAutoFlow = '';
        rowsEl.style.gridTemplateRows = '';
        rowsEl.style.columnGap = '';
    }

    const margin = 12;
    const availH = window.innerHeight - margin * 2;

    if (rowsEl && rowsEl.children.length > 1) {
        // The column's full height is averaged across the rows so the figure includes each row's margin and the columns do not pack too tightly.
        const rowH = (rowsEl.scrollHeight / rowsEl.children.length) || 18;
        const headerH = tooltipEl.querySelector('.tt-header')?.offsetHeight || 0;
        // The rows may fill the viewport minus the header, the tooltip's own padding and a small gap. Rows per column is the lever, since fewer rows means more columns.
        const usableH = availH - headerH - 34;
        const rowsPerCol = Math.max(1, Math.floor(usableH / rowH));
        if (rowsEl.children.length > rowsPerCol) {
            rowsEl.style.display = 'grid';
            rowsEl.style.gridAutoFlow = 'column';
            rowsEl.style.gridTemplateRows = `repeat(${rowsPerCol}, auto)`;
            rowsEl.style.columnGap = '16px';
        }
    }

    // Place near the cursor, flipping side or clamping so the whole tooltip stays inside the viewport.
    const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
    let x = clientX + 16, y = clientY + 16;
    if (x + w > window.innerWidth - margin) x = clientX - w - 16;
    if (x < margin) x = margin;
    if (y + h > window.innerHeight - margin) y = window.innerHeight - margin - h;
    if (y < margin) y = margin;
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';
}

// Hint tooltips use fixed positioning, so they cannot widen the page, and they clamp to the viewport. The hint is read back with textContent, so a heading cannot add markup.
function ensureHintTooltip() {
    let el = document.getElementById('hint-tooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'hint-tooltip';
        el.className = 'hint-tooltip';
        el.setAttribute('role', 'tooltip');
        document.body.appendChild(el);
    }
    return el;
}

function placeHintTooltip(el, anchor) {
    const margin = 12;
    const r = anchor.getBoundingClientRect();
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth, h = el.offsetHeight;
    // Centred under the trigger by preference, then pulled back inside whichever edge it crosses.
    let x = r.left + r.width / 2 - w / 2;
    let y = r.bottom + 8;
    if (x + w > window.innerWidth - margin) x = window.innerWidth - margin - w;
    if (x < margin) x = margin;
    // Above the trigger when there is no room below, which is what the bottom row of panels needs.
    if (y + h > window.innerHeight - margin) y = Math.max(margin, r.top - h - 8);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
}

/**
 * Says whether the primary pointer is coarse (touch), read on each call because a hybrid device can switch.
 *
 * @returns {boolean} True on a coarse pointer.
 */
export function isCoarsePointer() {
    return window.matchMedia('(pointer: coarse)').matches;
}

let openHintTarget = null;

/**
 * Wires document-level tooltips for every `[data-hint]` element, on hover and focus or on tap for a coarse pointer.
 */
export function setupHintTooltips() {
    const show = (target) => {
        const text = target.getAttribute('data-hint');
        if (!text) return;
        const el = ensureHintTooltip();
        el.textContent = text;
        el.style.display = 'block';
        placeHintTooltip(el, target);
    };
    const hide = () => {
        const el = document.getElementById('hint-tooltip');
        if (el) el.style.display = 'none';
        openHintTarget = null;
    };
    // On a coarse pointer a tap can synthesize a trailing mouseover, so mouse events are ignored there. Focus and blur stay on for keyboard users.
    document.addEventListener('mouseover', (e) => {
        if (isCoarsePointer()) return;
        const target = e.target.closest?.('[data-hint]');
        if (target) show(target);
    });
    document.addEventListener('mouseout', (e) => {
        if (isCoarsePointer()) return;
        if (e.target.closest?.('[data-hint]')) hide();
    });
    document.addEventListener('focusin', (e) => {
        const target = e.target.closest?.('[data-hint]');
        if (target) show(target);
    });
    document.addEventListener('focusout', hide);
    // A second tap on the same trigger closes it, a tap on another trigger moves the tooltip, and a tap elsewhere closes it. preventDefault stops a synthetic click on whatever sits under the trigger.
    document.addEventListener('click', (e) => {
        if (!isCoarsePointer()) return;
        const target = e.target.closest?.('[data-hint]');
        if (target && target === openHintTarget) { hide(); return; }
        if (target) { e.preventDefault(); show(target); openHintTarget = target; return; }
        if (openHintTarget) hide();
    });
    // A scroll or resize moves the anchor out from under a tooltip measured against the old layout.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
}

let dataTooltipDismissWired = false;
let openTooltipTarget = null;

/**
 * Wires a floating tooltip for every `[data-tooltip]` element inside a container.
 *
 * @param {Element|null} container The element whose descendants are wired; a falsy value is ignored.
 */
export function attachDataTooltips(container) {
    if (!container) return;
    const tooltipEl = ensureFloatingTooltip();

    const showAt = (el, x, y) => {
        // Text only. getAttribute decodes the entities the write sites escaped, so setting it as markup would re-arm hostile markup in names.
        tooltipEl.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = el.getAttribute('data-tooltip');
        tooltipEl.appendChild(strong);
        tooltipEl.style.display = 'block';
        // Same clamp and flip as layoutHoverTooltip, so a long wrapped tip stays inside the viewport.
        const margin = 12;
        const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
        let left = x + 15, top = y + 15;
        if (left + w > window.innerWidth - margin) left = x - w - 15;
        if (left < margin) left = margin;
        if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
        if (top < margin) top = margin;
        tooltipEl.style.left = left + 'px';
        tooltipEl.style.top = top + 'px';
    };
    const hide = () => {
        tooltipEl.style.display = 'none';
        openTooltipTarget = null;
    };

    container.querySelectorAll('[data-tooltip]').forEach(el => {
        el.addEventListener('mousemove', (e) => {
            if (isCoarsePointer()) return;
            e.stopPropagation();
            showAt(el, e.clientX, e.clientY);
        });
        el.addEventListener('mouseleave', (e) => {
            if (isCoarsePointer()) return;
            e.stopPropagation();
            tooltipEl.style.display = 'none';
        });
        // A second tap on the same region closes it. A tap has no cursor point, so the tip is placed off the region's own centre.
        el.addEventListener('click', (e) => {
            if (!isCoarsePointer()) return;
            e.stopPropagation();
            if (openTooltipTarget === el) { hide(); return; }
            const r = el.getBoundingClientRect();
            showAt(el, r.left + r.width / 2, r.top);
            openTooltipTarget = el;
        });
    });

    if (!dataTooltipDismissWired) {
        dataTooltipDismissWired = true;
        document.addEventListener('click', (e) => {
            if (!isCoarsePointer() || !openTooltipTarget) return;
            if (e.target.closest?.('[data-tooltip]') === openTooltipTarget) return; // its own handler above
            hide();
        });
    }
}

/**
 * How many matchups a line chart needs before it draws a line rather than a lone dot.
 *
 * @type {number}
 */
export const MIN_MATCHUPS_FOR_A_LINE = 2;

// Places a chip's neighbour table in the page layer from the chip's own rect, because the strip's overflow would clip it. It is kept inside the viewport.
function placeChipDropdown(chip) {
    const dd = chip?.querySelector?.(':scope > .rank-chip-dropdown');
    if (!dd) return;
    const r = chip.getBoundingClientRect();
    const w = dd.offsetWidth, h = dd.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - w - margin));
    // Below the chip, or above it when the viewport has no room underneath.
    const below = r.bottom + 6;
    const top = below + h + margin > window.innerHeight && r.top - h - 6 >= margin ? r.top - h - 6 : below;
    dd.style.setProperty('--dd-x', `${Math.round(left)}px`);
    dd.style.setProperty('--dd-y', `${Math.round(top)}px`);
}

/**
 * Wires touch-and-hold on rank and stat chips to open their dropdown, and places a stat chip's table when the pointer enters it.
 */
export function setupLongPressDisclosures() {
    const HOLD_MS = 500;
    const SELECTOR = '.rank-chip, .stat-chip';
    const OPEN_CLASS = 'touch-open';
    let timer = null;
    let pressTarget = null;

    const clearOpen = () => {
        document.querySelectorAll(`.${OPEN_CLASS}`).forEach(el => el.classList.remove(OPEN_CLASS));
    };
    const cancelTimer = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        pressTarget = null;
    };

    // Placed on entry, well before the hover delay shows it; a chip the pointer crosses without lingering costs one rect read.
    document.addEventListener('mouseover', (e) => {
        const chip = e.target.closest?.('.stat-chip');
        if (chip) placeChipDropdown(chip);
    });

    document.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        const target = e.target.closest?.(SELECTOR);
        if (!target) return;
        pressTarget = target;
        timer = setTimeout(() => {
            clearOpen();
            placeChipDropdown(target);
            target.classList.add(OPEN_CLASS);
            timer = null;
        }, HOLD_MS);
    });
    // A finger that lifts or drags before the hold completes was a tap or a scroll, so the hold is cancelled.
    document.addEventListener('pointerup', cancelTimer);
    document.addEventListener('pointercancel', cancelTimer);
    document.addEventListener('pointermove', (e) => {
        if (timer && e.target.closest?.(SELECTOR) !== pressTarget) cancelTimer();
    });
    // A tap outside the open chip closes it. A quick tap on the same chip runs its own click handler and should not leave the table open.
    document.addEventListener('click', (e) => {
        if (!isCoarsePointer()) return;
        if (!document.querySelector(`.${OPEN_CLASS}`)) return;
        clearOpen();
    });
}

// The diagnostic panel shows one capture kind at a time. Each kind's payload is tracked on its own, so a background fetch cannot overwrite the kind on screen.
const DEBUG_LABELS = {
    team: 'Team Schema',
    'player-pool': 'Player Pool Schema',
    'player-weekly': 'Weekly Stats Chunk',
    'player-detail': 'Player Detail Schema',
    // The leagueHistory array, one entry per season the league has existed.
    'league-history': 'League History Schema',
    // The roster response, the one view that carries lineupSlotId. It is a kind of its own because a download from here is always a roster response, whichever period landed last.
    roster: 'Roster Schema',
    // The whole season's lineups, written once at the end of a harvest. It separates starters from the bench, which a roster snapshot cannot.
    'roster-days': 'Roster Days Schema',
    // The remaining fetches the app makes, each written on its own fetch's success path. An empty kind is skipped by the zip.
    'draft-detail': 'Draft Detail Schema',
    'pro-schedule': 'Pro Schedule Schema',
    odds: 'Scoreboard Odds Schema',
    transactions: 'Transactions Schema',
    'history-pool': 'History Pool Schema'
};
const debugContexts = {
    team: null, 'player-pool': null, 'player-weekly': null, 'player-detail': null,
    'league-history': null, roster: null, 'roster-days': null, 'draft-detail': null, 'pro-schedule': null,
    odds: null, transactions: null, 'history-pool': null
};
// Past seasons' captures, kept apart from the season on screen as { season: { kind: payload } } and stamped with the league. A payload that names another season is routed here.
let debugSeasonContexts = { league: null, seasons: {} };
// The league each kind's payload was captured under, so a zip never packs one league's capture beside another's after a league switch.
const debugContextLeagueKeys = {
    team: null, 'player-pool': null, 'player-weekly': null, 'player-detail': null,
    'league-history': null, roster: null, 'roster-days': null, 'draft-detail': null, 'pro-schedule': null,
    odds: null, transactions: null, 'history-pool': null
};
// Duplicated from api.js because api.js imports this module and the reverse import would be a cycle.
function currentLeagueKey() {
    const sport = document.getElementById('sport')?.value;
    const leagueId = document.getElementById('league-id')?.value;
    const year = document.getElementById('year')?.value;
    return `${sport}:${leagueId}:${year}`;
}
// Whether a kind holds a payload captured for the league on screen. A stale kind reads as empty.
function matchesCurrentLeague(kind) {
    return !!debugContexts[kind] && debugContextLeagueKeys[kind] === currentLeagueKey();
}
// The season a payload says it is, where it says: ESPN's league-shaped responses carry seasonId at the top. A pool, a schedule and the distilled lineups carry none, and null means "does not say".
function seasonOfPayload(payload) {
    const season = payload && !Array.isArray(payload) ? Number(payload.seasonId) : NaN;
    return Number.isFinite(season) && season > 0 ? season : null;
}
function currentSeason() {
    const year = Number(document.getElementById('year')?.value);
    return Number.isFinite(year) && year > 0 ? year : null;
}
function currentLeagueOnly() {
    return `${document.getElementById('sport')?.value}:${document.getElementById('league-id')?.value}`;
}
/**
 * Stores a past season's captured payload for that season's folder in the zip.
 *
 * @param {number|string} season The season the payload belongs to.
 * @param {string} kind The capture kind.
 * @param {*} payload The raw response.
 */
export function setSeasonDebugContext(season, kind, payload) {
    const league = currentLeagueOnly();
    if (debugSeasonContexts.league !== league) debugSeasonContexts = { league, seasons: {} };
    const key = String(season);
    (debugSeasonContexts.seasons[key] = debugSeasonContexts.seasons[key] || {})[kind] = payload;
}
/**
 * Says whether a past season's capture of a kind is held for the league on screen.
 *
 * @param {number|string} season The season.
 * @param {string} kind The capture kind.
 * @returns {boolean} True when the payload is held.
 */
export function hasSeasonDebugContext(season, kind) {
    return debugSeasonContexts.league === currentLeagueOnly() && !!(debugSeasonContexts.seasons[String(season)] || {})[kind];
}
/**
 * Lists every past-season capture held for the league on screen.
 *
 * @returns {Array<{season: number, kind: string, payload: *}>} Rows in season then kind order; empty after a league switch.
 */
export function debugSeasonContextRows() {
    if (debugSeasonContexts.league !== currentLeagueOnly()) return [];
    const rows = [];
    Object.keys(debugSeasonContexts.seasons).sort().forEach(season => {
        Object.keys(debugSeasonContexts.seasons[season]).sort().forEach(kind => {
            const payload = debugSeasonContexts.seasons[season][kind];
            if (payload) rows.push({ season: Number(season), kind, payload });
        });
    });
    return rows;
}
// Set while an on-demand diagnostic fetch is in flight, so the panel shows a loading line and not the empty placeholder.
const debugLoading = { team: false, 'player-pool': false, 'player-weekly': false, 'player-detail': false };
// Set once the user picks a kind by hand. From then on the panel stops following the view.
let debugKindPinned = false;
// A one-off line the panel shows in place of its empty placeholder. It lives here because the panel re-renders on its own and would overwrite a message written straight into the element.
let debugNotice = null;
let activeDebugKind = 'team';
// The payload on screen, kept as the raw object so the download is clean, parseable JSON.
let lastDebugPayload = null;

/**
 * Stores a captured response for the diagnostic panel, routing a payload that names another season to that season's slot.
 *
 * @param {string} kind The capture kind, such as 'team' or 'player-pool'.
 * @param {*} payload The raw response.
 */
export function setDebugContext(kind, payload) {
    // A payload that names another season goes to that season's slot and leaves the one on screen alone. A single period of another season's transaction log is not kept, since it would read as that season's whole log.
    const named = seasonOfPayload(payload);
    const onScreen = currentSeason();
    if (named !== null && onScreen !== null && named !== onScreen) {
        if (!(kind === 'transactions' && !payload.harvest)) setSeasonDebugContext(named, kind, payload);
        return;
    }
    debugContexts[kind] = payload;
    debugContextLeagueKeys[kind] = currentLeagueKey();
    // A capture landing answers the notice, whatever it said.
    debugNotice = null;
    // A newly captured kind gets its button enabled straight away, whatever is on screen.
    renderDebugPicker();
    debugLoading[kind] = false;
    // A pool landing while the panel is showing the weekly stand-in promotes itself, so the view never sits on the substitute once the real thing is available.
    if (kind === 'player-pool' && activeDebugKind === 'player-weekly') activeDebugKind = 'player-pool';
    if (kind === activeDebugKind) renderActiveDebugContext();
}

/**
 * Says whether a kind holds a capture for the league on screen.
 *
 * @param {string} kind The capture kind.
 * @returns {boolean} False for an empty kind and for one captured under a different league.
 */
export function hasDebugContext(kind) {
    return matchesCurrentLeague(kind);
}

/**
 * Reads the captured payload of a kind for the league on screen.
 *
 * @param {string} kind The capture kind.
 * @returns {*} The payload, or null when the kind is empty or belongs to another league.
 */
export function debugContextFor(kind) {
    return matchesCurrentLeague(kind) ? debugContexts[kind] : null;
}

/**
 * Marks a kind as being fetched right now, so the panel shows a loading line instead of the empty placeholder.
 *
 * @param {string} kind The capture kind.
 * @param {boolean} isLoading Whether a fetch is in flight.
 */
export function setDebugLoading(kind, isLoading) {
    debugLoading[kind] = isLoading;
    if (kind === activeDebugKind) renderActiveDebugContext();
}

/**
 * Sets which kind the diagnostic panel follows when the view changes, unless the reader has pinned one.
 *
 * @param {string} kind The capture kind that matches the view on screen.
 */
export function setActiveDebugKind(kind) {
    debugNotice = null;
    // A hand-picked kind holds, because picking is an explicit instruction and outranks following the view.
    if (debugKindPinned) return;
    // Before the pool lands, the weekly chunk is the only player response, so the panel shows it under its own name.
    activeDebugKind = (kind === 'player-pool' && !debugContexts['player-pool'] && debugContexts['player-weekly'])
        ? 'player-weekly'
        : kind;
    renderActiveDebugContext();
}

/**
 * Pins the panel to a kind the reader picked, so later view changes do not move it.
 *
 * @param {string} kind The capture kind; an unknown kind is ignored.
 */
export function pinDebugKind(kind) {
    if (!(kind in debugContexts)) return;
    debugKindPinned = true;
    activeDebugKind = kind;
    renderActiveDebugContext();
}

// The weekly kind's label carries the player count it holds, since it accumulates every chunk of a run.
function labelFor(kind) {
    const base = DEBUG_LABELS[kind] || 'Schema';
    if (kind === 'player-weekly' && matchesCurrentLeague(kind)) {
        const n = (debugContexts[kind].players || []).length;
        return `${base} (${n} player${n === 1 ? '' : 's'})`;
    }
    return base;
}

// One button per kind, disabled while that kind holds nothing.
function renderDebugPicker() {
    const host = document.getElementById('debug-kinds');
    if (!host) return;
    host.innerHTML = Object.keys(DEBUG_LABELS).map(kind => {
        const has = matchesCurrentLeague(kind);
        const on = kind === activeDebugKind;
        return `<button type="button" class="debug-kind${on ? ' active' : ''}" data-kind="${kind}"
                    ${has ? '' : 'disabled'}
                    title="${has ? 'Show this response' : 'Nothing captured for this yet'}">${labelFor(kind)}</button>`;
    }).join('');
}

/**
 * Re-renders the panel's current capture and, when the panel is enabled, the request tally.
 */
export function refreshDebugPanel() {
    renderActiveDebugContext();
    // The tally is redrawn even when no payload landed, since the panel can be opened long after the last fetch.
    if (diagnosticPanelEnabled) renderRequestTally();
}

// The tally in two groups that are not summed, because an API call carries league data and an image load carries a public id.
function renderRequestTally() {
    const host = document.getElementById('debug-tally');
    if (!host) return;
    const t = getRequestTally();
    const since = new Date(t.startedAt).toLocaleTimeString();
    const breakdown = (map) => Object.keys(map).sort().map(k => `${escapeHtml(k)} ${map[k]}`).join(', ');
    const apiDetail = t.api.total
        ? `<div class="debug-tally-detail">${breakdown(t.api.byKind)}</div><div class="debug-tally-detail">${breakdown(t.api.byHost)}</div>`
        : '';
    const imgDetail = t.images.total ? `<div class="debug-tally-detail">${breakdown(t.images.byHost)}</div>` : '';
    host.innerHTML = `
        <div class="debug-tally-row"><b>API calls</b> ${t.api.total}${apiDetail}</div>
        <div class="debug-tally-row"><b>Images shown</b> ${t.images.total}${imgDetail}</div>
        <div class="debug-tally-note">Counted since this page opened at ${escapeHtml(since)}. Images count what rendered, not network traffic. Nothing is stored.</div>`;
}

// The panel is off by default and, when off, is not on the page at all. Every path that shows it goes through renderActiveDebugContext, so one check there is the whole gate.
let diagnosticPanelEnabled = false;

/**
 * Shows or hides the diagnostic panel as a whole, closing it when it is turned off.
 *
 * @param {boolean} on Whether the panel is enabled.
 */
export function setDiagnosticPanelEnabled(on) {
    diagnosticPanelEnabled = !!on;
    const debugPanel = document.getElementById('debug-panel');
    if (!debugPanel) return;
    if (!diagnosticPanelEnabled) {
        // Closed as well as hidden, so the container's pinned height is released through the normal close path.
        debugPanel.open = false;
        debugPanel.style.display = 'none';
        return;
    }
    // Turning it back on re-runs the normal render, which shows the panel if anything was captured.
    renderActiveDebugContext();
}

function renderActiveDebugContext() {
    if (!diagnosticPanelEnabled) return;
    const debugPanel = document.getElementById('debug-panel');
    const output = document.getElementById('debug-output');
    if (!debugPanel || !output) return;
    renderDebugPicker();
    if (debugPanel.open) renderRequestTally();
    // A stale kind reads as empty, the same placeholder a kind never fetched shows, never the old league's data under the new label.
    const payload = matchesCurrentLeague(activeDebugKind) ? debugContexts[activeDebugKind] : null;
    const label = labelFor(activeDebugKind);
    if (!payload) {
        // With nothing captured, an explicit placeholder under the right label is shown instead of a stale payload from the kind that was active before.
        if (debugPanel.style.display === 'block') {
            output.textContent = debugNotice
                || (debugLoading[activeDebugKind]
                    ? `${label}: loading...`
                    : `${label}: no diagnostic payload captured for this view yet.`);
        }
        return;
    }
    debugPanel.style.display = 'block';
    // The downloadable copy keeps the full raw payload, since the preview slices out only one entry.
    lastDebugPayload = payload;
    if (!debugPanel.open) return; // lazy: don't stringify a large payload while collapsed
    const preview = activeDebugKind === 'team'
        ? (payload.teams?.[0] || {})
        : ((payload.players || [])[0] || payload);
    output.textContent = `${label} (preview only, download for the full response):\n` + JSON.stringify(preview, null, 2);
}

/**
 * Saves the capture on screen as a pretty-printed JSON file; does nothing when none is shown.
 */
export function downloadDebugData() {
    if (!lastDebugPayload) return;
    const blob = new Blob([JSON.stringify(lastDebugPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `espn-debug-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Builds the draft room snapshot's file for the zip, or null when there is nothing to file.
 *
 * @param {Object|null} snapshot The stored room snapshot.
 * @param {Object} [opts] Options.
 * @param {{leagueId: number, seasonId: number}|null} [opts.loaded] The league loaded on the page, for the match check.
 * @param {number} [opts.now] The clock in milliseconds.
 * @returns {{name: string, text: string}|null} The file name and its JSON text.
 */
export function roomSnapshotFile(snapshot, { loaded = null, now = Date.now() } = {}) {
    const kind = roomSnapshotExport(snapshot, { loaded, now });
    if (!kind) return null;
    return { name: 'room-snapshot.json', text: JSON.stringify(kind, null, 2) };
}

function loadedLeagueForRoom() {
    const leagueId = document.getElementById('league-id')?.value;
    const seasonId = document.getElementById('year')?.value;
    if (!leagueId || !seasonId) return null;
    const out = { leagueId: Number(leagueId), seasonId: Number(seasonId) };
    return Number.isFinite(out.leagueId) && Number.isFinite(out.seasonId) ? out : null;
}

// The extension's own version off its manifest, or null on a page that is not an extension's, so an index never guesses a build.
function extensionVersion() {
    try { return browser.runtime.getManifest().version || null; } catch { return null; }
}

// The kinds written compact, because zip.js stores without compressing and these are tens of megabytes of stat lines when pretty-printed.
const COMPACT_KINDS = new Set(['player-weekly', 'player-pool', 'history-pool', 'roster-days']);

/**
 * Packs every capture held for the league on screen into one zip with an index, and downloads it.
 *
 * @param {function(): Promise<void>} [ensureLazy] Fills the kinds fetched only on demand; awaited first, and a failure is ignored.
 * @param {Object} [opts] Options.
 * @param {Object|null} [opts.ledger] The capture run's ledger, written into the index.
 * @returns {Promise<string|undefined>} The downloaded file's name, or undefined when there was nothing to download.
 */
export async function downloadAllDebugData(ensureLazy, { ledger = null } = {}) {
    if (typeof ensureLazy === 'function') {
        try { await ensureLazy(); } catch { /* a kind that would not load is absent */ }
    }
    const now = new Date();
    const encoder = new TextEncoder();
    const encode = (kind, payload) => encoder.encode(COMPACT_KINDS.has(kind) ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
    const seasonRows = debugSeasonContextRows();
    const files = Object.keys(DEBUG_LABELS)
        // Never a stale kind, since a zip must not carry two leagues.
        .filter(kind => matchesCurrentLeague(kind))
        // The history pool holds the last past pool fetched. When the same payload goes into its own season's folder it is left out here.
        .filter(kind => !seasonRows.some(r => r.payload === debugContexts[kind]))
        .map(kind => ({ kind, name: `${kind}.json`, bytes: encode(kind, debugContexts[kind]) }));
    // Each past season gets a folder of its own, so another year's draft or pool never sits beside this season's league payload.
    seasonRows.forEach(r => {
        files.push({ kind: r.kind, season: r.season, name: `${r.season}/${r.kind}.json`, bytes: encode(r.kind, r.payload) });
    });
    // The room snapshot is read at the moment of the download through a dynamic import, because api.js imports this module and a static import back would be a cycle. A failure leaves the file out, never the zip.
    try {
        const { readRoomState } = await import('../data/api.js');
        const room = roomSnapshotFile(await readRoomState(), { loaded: loadedLeagueForRoom(), now: now.getTime() });
        if (room) files.push({ kind: 'room', name: room.name, bytes: encoder.encode(room.text) });
    } catch { /* no snapshot is a room nobody opened, not a broken download */ }
    // An archive of nothing reads as a broken download, so the panel says there was nothing to send.
    if (!files.length) {
        debugNotice = 'No diagnostic payloads captured yet. Nothing to download.';
        renderActiveDebugContext();
        return;
    }
    // The index goes first in the archive. It is built from the files actually going in, so it cannot name a file the zip lacks, and it carries no league id or team name.
    const league = AppState.apiData || null;
    const status = (league && league.status) || {};
    const index = buildCaptureIndex({
        league: league ? {
            sport: document.getElementById('sport')?.value || null,
            season: league.seasonId ?? null,
            format: league.settings?.scoringSettings?.scoringType || null,
            teams: (league.teams || []).length,
            state: Number(status.latestScoringPeriod) > Number(status.finalScoringPeriod) ? 'finished'
                : (Number(status.latestScoringPeriod) > 0 ? 'underway' : 'not started')
        } : null,
        files: files.map(f => ({ kind: f.kind, season: f.season, name: f.name, bytes: f.bytes.length })),
        ledger,
        version: extensionVersion(),
        at: now.toISOString()
    });
    files.unshift({ kind: 'index', name: 'INDEX.json', bytes: encoder.encode(JSON.stringify(index, null, 2)) });

    const blob = new Blob([buildZip(files, now)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `espn-debug-all-${now.getTime()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    // The name, so the panel can say what it wrote.
    return a.download;
}

// ==== Scoring period to matchup ====

/**
 * Maps a scoring period to its week, the exact inverse of midPeriodOfWeek.
 *
 * @param {number} scoringPeriodId The scoring period.
 * @param {number} [firstScoringPeriod] The league's first scoring period.
 * @returns {number} The week, at least 1.
 */
export function weekOfPeriod(scoringPeriodId, firstScoringPeriod = 1) {
    const first = Number(firstScoringPeriod) || 1;
    return Math.max(1, Math.floor((Number(scoringPeriodId) - first) / 7) + 1);
}

/**
 * Gives the fourth day of a week, the proxy for who held a player across the week.
 *
 * @param {number} week The week, at least 1.
 * @param {number} [firstScoringPeriod] The league's first scoring period.
 * @returns {number} The scoring period in the middle of that week.
 */
export function midPeriodOfWeek(week, firstScoringPeriod = 1) {
    const first = Number(firstScoringPeriod) || 1;
    return first + (Math.max(1, Number(week) || 1) - 1) * 7 + 3;
}

/**
 * Gives the one line a category surface shows when a sport's stat ids are not mapped yet.
 *
 * @param {string} sport The sport key.
 * @returns {string} The sentence.
 */
export function unmappedCategoriesNote(sport) {
    return `${SPORT_NAMES[sport] || 'This sport'} categories aren't mapped yet.`;
}

/**
 * Builds the league's day-to-matchup map from its own schedule.
 *
 * @param {Array<Object>} schedule The league's schedule games.
 * @param {Object|null} status The league's status block.
 * @param {Object|null} [settings] The league settings; adds the week counts that spans need and changes nothing else.
 * @returns {MatchupPeriodMap} The map; empty for a roto league.
 */
export function buildMatchupPeriodMap(schedule, status, settings = null) {
    const byPeriod = new Map();
    let lastPeriod = 0;
    let lastMatchup = 0;
    (schedule || []).forEach(game => {
        const mp = game && game.matchupPeriodId;
        if (!mp) return;
        let contributed = false;
        ['home', 'away'].forEach(side => {
            const pts = (game[side] || {}).pointsByScoringPeriod;
            if (!pts) return;
            Object.keys(pts).forEach(key => {
                const period = Number(key);
                if (!Number.isFinite(period) || period <= 0) return;
                // The LOWEST matchup wins a contested day. Nothing in the captures contests one, but a day filed under two matchups belongs to the earlier one that was live.
                const prev = byPeriod.get(period);
                if (prev === undefined || mp < prev) byPeriod.set(period, mp);
                if (period > lastPeriod) lastPeriod = period;
                contributed = true;
            });
        });
        if (contributed && mp > lastMatchup) lastMatchup = mp;
    });
    // The matchup being played right now, straight from the payload. This is what resolves days the schedule has not scored yet, and it is a fact rather than an extrapolation.
    const currentMatchup = (status || {}).currentMatchupPeriod || 0;
    // The week counts are read for their lengths only. Their values are week indices, not scoring periods, so they are never treated as days.
    const weeksByMatchup = new Map();
    const declared = ((settings || {}).scheduleSettings || {}).matchupPeriods || {};
    Object.keys(declared).forEach(key => {
        const matchup = Number(key);
        const weeks = Array.isArray(declared[key]) ? declared[key].length : 0;
        if (Number.isFinite(matchup) && matchup > 0 && weeks > 0) weeksByMatchup.set(matchup, weeks);
    });
    const finalPeriod = Number((status || {}).finalScoringPeriod) || 0;
    const map = { byPeriod, lastPeriod, lastMatchup, currentMatchup, weeksByMatchup, finalPeriod };
    // The open matchup's span is computed once and carried on the map, so a module that imports nothing can read the same answer.
    map.currentSpan = spanOfOpenMatchup(map);
    return map;
}

// The first and last day of the matchup being played, or null when the league cannot answer (roto, an unscored schedule, no settings).
function spanOfOpenMatchup(map) {
    const current = map.currentMatchup;
    if (!current || !map.byPeriod.size) return null;
    const scored = [];
    map.byPeriod.forEach((mp, period) => { if (mp === current) scored.push(period); });
    scored.sort((a, b) => a - b);
    const start = scored.length ? scored[0] : map.lastPeriod + 1;
    const weeks = (map.weeksByMatchup && map.weeksByMatchup.get(current)) || 0;
    const final = map.finalPeriod || 0;
    if (!weeks || !final || final < start) return null;
    let weeksAhead = 0;
    map.weeksByMatchup.forEach((w, m) => { if (m >= current) weeksAhead += w; });
    if (!weeksAhead) return null;

    let end = start + Math.round((final - start + 1) * weeks / weeksAhead) - 1;
    let nextStart = null;
    map.byPeriod.forEach((mp, period) => {
        if (mp > current && (nextStart === null || period < nextStart)) nextStart = period;
    });
    if (nextStart !== null && end >= nextStart) end = nextStart - 1;
    if (end > final) end = final;
    const last = scored.length ? scored[scored.length - 1] : start - 1;
    if (end < last) end = last;
    return { start, end };
}

/**
 * Lists the scoring periods one matchup covers, including the days the matchup being played has not reached.
 *
 * @param {MatchupPeriodMap|null} map The map from buildMatchupPeriodMap.
 * @param {number} matchupNumber The matchup.
 * @returns {number[]} The periods in ascending order; empty for an unknown matchup.
 */
export function scheduledPeriodsOfMatchup(map, matchupNumber) {
    if (!map || !map.byPeriod || !matchupNumber) return [];
    const scored = [];
    map.byPeriod.forEach((mp, period) => { if (mp === matchupNumber) scored.push(period); });
    scored.sort((a, b) => a - b);
    if (matchupNumber === map.currentMatchup + 1 && !scored.length) {
        const next = nextMatchupSpan(map);
        if (!next) return scored;
        const out = [];
        for (let period = next.start; period <= next.end; period++) out.push(period);
        return out;
    }
    if (matchupNumber !== map.currentMatchup) return scored;

    // The span is the one computed when the map was built, so probables.js reads the same days without importing this module.
    const span = map.currentSpan || spanOfOpenMatchup(map);
    if (!span) return scored;
    const { start, end } = span;

    const last = scored.length ? scored[scored.length - 1] : start - 1;
    if (end <= last) return scored;
    const out = scored.slice();
    for (let period = last + 1; period <= end; period++) out.push(period);
    return out;
}

/**
 * Gives the first and last day of the matchup after the one being played, before it has scored a day.
 *
 * @param {MatchupPeriodMap|null} map The map from buildMatchupPeriodMap.
 * @returns {{start: number, end: number}|null} The span, or null when it cannot be derived.
 */
export function nextMatchupSpan(map) {
    if (!map || !map.currentMatchup) return null;
    const open = map.currentSpan || spanOfOpenMatchup(map);
    const next = map.currentMatchup + 1;
    const weeks = (map.weeksByMatchup && map.weeksByMatchup.get(next)) || 0;
    const final = map.finalPeriod || 0;
    if (!open || !weeks || !final) return null;
    const start = open.end + 1;
    if (start > final) return null;
    let weeksAhead = 0;
    map.weeksByMatchup.forEach((w, m) => { if (m >= next) weeksAhead += w; });
    if (!weeksAhead) return null;
    const end = Math.min(final, start + Math.floor((final - start + 1) * weeks / weeksAhead) - 1);
    return end >= start ? { start, end } : null;
}

/**
 * Finds who a team meets in one matchup.
 *
 * @param {Array<Object>} schedule The league's schedule games.
 * @param {number} matchupNumber The matchup.
 * @param {number|string} teamId The team.
 * @returns {number|null} The opponent's team id, or null when the schedule has no such game.
 */
export function scheduledOpponentOf(schedule, matchupNumber, teamId) {
    if (teamId === null || teamId === undefined || !matchupNumber) return null;
    const id = String(teamId);
    const game = (schedule || []).find(g => g && g.matchupPeriodId === matchupNumber
        && ((g.home && String(g.home.teamId) === id) || (g.away && String(g.away.teamId) === id)));
    if (!game) return null;
    const other = String(game.home && game.home.teamId) === id ? game.away : game.home;
    return other && other.teamId !== null && other.teamId !== undefined ? other.teamId : null;
}

/**
 * Finds the matchup a scoring period belongs to.
 *
 * @param {MatchupPeriodMap|null} map The map from buildMatchupPeriodMap.
 * @param {number} scoringPeriodId The scoring period.
 * @returns {number|null} The matchup, or null when the map is empty.
 */
export function matchupOfPeriod(map, scoringPeriodId) {
    if (!map || !map.byPeriod.size) return null;
    const known = map.byPeriod.get(scoringPeriodId);
    if (known !== undefined) return known;
    if (scoringPeriodId > map.lastPeriod) {
        if (map.currentMatchup >= map.lastMatchup) return map.currentMatchup;
        // No usable status. The ordinary 7-day cadence from the first unscored day is the last resort, right for a normal week and wrong the same way the old formula was for a long one.
        return map.lastMatchup + 1 + Math.floor((scoringPeriodId - map.lastPeriod - 1) / 7);
    }
    // A gap BELOW the last mapped day is an off day the schedule skipped, not a new matchup. Give it the nearest matchup already established before it.
    let best = null;
    map.byPeriod.forEach((mp, period) => {
        if (period < scoringPeriodId && (best === null || period > best.period)) best = { period, mp };
    });
    return best ? best.mp : null;
}

/**
 * Chooses which way a column opens on its first click, so the first click shows the best value.
 *
 * @param {string} key The column key or stat id.
 * @param {Set<string>} [inverseIds] The keys where lower is better.
 * @returns {'asc'|'desc'} 'asc' for a lower-is-better key, otherwise 'desc'.
 */
export function openingSortDir(key, inverseIds) {
    return (inverseIds && inverseIds.has(key)) ? 'asc' : 'desc';
}

// The registry of tabs. Each tab registers how to clear and how to show itself, and a view that throws is logged while the rest still run.
const leagueViews = new Map();
let activeLeagueView = 'team';

/**
 * Registers a tab's reset, show and revalidate handlers, merging with handlers registered from another file.
 *
 * @param {string} name The tab name.
 * @param {{reset?: function(): void, show?: function(): void, revalidate?: function(): void}} handlers The handlers to add.
 */
export function registerLeagueView(name, handlers) {
    leagueViews.set(name, { ...(leagueViews.get(name) || {}), ...handlers });
}

function setActiveLeagueView(name) {
    if (leagueViews.has(name)) activeLeagueView = name;
}

/**
 * Marks a registered tab as the active one and runs its show handler.
 *
 * @param {string} name The tab name.
 */
export function showLeagueView(name) {
    setActiveLeagueView(name);
    const view = leagueViews.get(name);
    if (view && view.show) view.show();
}

/**
 * Runs every registered reset handler for a league switch; a handler that throws is logged and the rest still run.
 */
export function resetLeagueViews() {
    leagueViews.forEach((view, name) => {
        if (!view.reset) return;
        try {
            view.reset();
        } catch (err) {
            console.error(`League switch: ${name} failed to reset`, err && err.stack || err);
        }
    });
}

/**
 * Runs every registered revalidate handler, which drops what a tab caches for the session without clearing the screen.
 */
export function revalidateLeagueViews() {
    leagueViews.forEach((view, name) => {
        if (!view || !view.revalidate) return;
        try {
            view.revalidate();
        } catch (err) {
            console.error(`League revalidate: ${name} failed`, err);
        }
    });
}

/**
 * Redraws the active tab after a fetch has committed; a render that throws is logged with its stack.
 */
export function renderActiveLeagueView() {
    const view = leagueViews.get(activeLeagueView);
    if (!view || !view.show) return;
    try {
        view.show();
    } catch (err) {
        // The stack is logged and not just the message, so a swallowed view exception can still be traced. console.error is used on purpose so a failed render shows up in the zero-errors check.
        console.error(`League switch: ${activeLeagueView} failed to render`, err && err.stack || err);
    }
}

/**
 * Unions the seasons a league is known to have with the loaded season and the real-world year.
 *
 * @param {Array<number|string>} historyYears The completed seasons from the league history.
 * @param {number|string} loadedSeasonId The season on screen.
 * @param {number|string} realYear The current calendar year.
 * @returns {number[]} Distinct positive years in ascending order.
 */
export function leagueSeasonYears(historyYears, loadedSeasonId, realYear) {
    return [...new Set([...(historyYears || []), loadedSeasonId, realYear])]
        .map(Number)
        .filter(y => Number.isFinite(y) && y > 0)
        .sort((a, b) => a - b);
}

// Seasons this session has loaded for a league, keyed by sport and league. A season ESPN served is known to exist, so it stays in the year list after another year loads.
const seasonsSeen = new Map();
/**
 * Remembers that a season loaded for a league, so the year list keeps it for the rest of the session.
 *
 * @param {string} sport The sport key.
 * @param {string|number} leagueId The league.
 * @param {number|string} season The season that loaded.
 */
export function noteSeasonSeen(sport, leagueId, season) {
    const y = Number(season);
    if (!sport || !leagueId || !Number.isFinite(y) || y <= 0) return;
    const key = `${sport}:${leagueId}`;
    if (!seasonsSeen.has(key)) seasonsSeen.set(key, new Set());
    seasonsSeen.get(key).add(y);
}
/**
 * Lists the seasons this session has loaded for a league.
 *
 * @param {string} sport The sport key.
 * @param {string|number} leagueId The league.
 * @returns {number[]} Years in ascending order.
 */
export function seasonsSeenFor(sport, leagueId) {
    return [...(seasonsSeen.get(`${sport}:${leagueId}`) || [])].sort((a, b) => a - b);
}

/**
 * Adds a season ESPN has named to a year list.
 *
 * @param {Array<number|string>} years The existing years.
 * @param {number|string} seasonId The season to add.
 * @returns {number[]} Distinct positive years, newest first.
 */
export function yearOptionsWith(years, seasonId) {
    const season = Number(seasonId);
    const all = [...(years || []), ...(Number.isFinite(season) && season > 0 ? [season] : [])];
    return [...new Set(all.map(Number))]
        .filter(y => Number.isFinite(y) && y > 0)
        .sort((a, b) => b - a);
}

/**
 * Builds the year dropdown after a load and the season it must show.
 *
 * @param {string|number} selectedValue The dropdown's current value.
 * @param {number|string} loadedSeasonId The season that loaded.
 * @param {Array<number|string>} historyYears The completed seasons from the league history.
 * @param {number|string} realYear The current calendar year.
 * @returns {{years: number[], selected: (number|null)}} The year options, newest first, and the chosen season.
 */
export function yearDropdownFor(selectedValue, loadedSeasonId, historyYears, realYear) {
    const picked = parseInt(selectedValue, 10);
    const loaded = Number(loadedSeasonId);
    const hasPicked = Number.isFinite(picked) && picked > 0;
    const hasLoaded = Number.isFinite(loaded) && loaded > 0;
    const selected = hasPicked ? picked : (hasLoaded ? loaded : null);
    const seasons = leagueSeasonYears(historyYears, hasLoaded ? loaded : selected, realYear);
    return { years: yearOptionsWith(seasons, selected), selected };
}

// Pins an element at its measured height and takes it out of the flex negotiation while a panel is open, so opening the panel pushes content down and nothing shrinks.
function pinHeight(element) {
    if (!element) return;
    const h = Math.round(element.getBoundingClientRect().height);
    if (h > 0) element.style.height = `${h}px`;
    element.classList.add('height-pinned');
}

function releaseHeight(element) {
    if (!element) return;
    element.style.height = '';
    element.classList.remove('height-pinned');
}

/**
 * Wires a details element so opening it pushes the page down instead of shrinking a flex neighbour.
 *
 * @param {HTMLDetailsElement|null} detailsEl The panel.
 * @param {HTMLElement|null} targetEl The element whose height is pinned while the panel is open.
 */
export function wirePushPanel(detailsEl, targetEl) {
    if (!detailsEl || !targetEl) return;
    const summary = detailsEl.querySelector('summary');
    if (summary) {
        summary.addEventListener('click', () => {
            if (!detailsEl.open) pinHeight(targetEl);
        });
    }
    detailsEl.addEventListener('toggle', () => {
        if (detailsEl.open) pinHeight(targetEl);
        else releaseHeight(targetEl);
    });
    if (detailsEl.open) pinHeight(targetEl);
}

// The session's request tally, in memory only, counted at the fetch site so the numbers are true from page open whether or not the panel is on. API calls and image loads are kept apart.
const requestTally = {
    startedAt: Date.now(),
    api: { total: 0, byHost: {}, byKind: {} },
    images: { total: 0, byHost: {} }
};

// No base URL on purpose. An unreadable URL is filed under 'unknown' and not under the extension's own host.
const hostOf = (url) => {
    try {
        return new URL(String(url)).hostname || 'unknown';
    } catch {
        return 'unknown';
    }
};

/**
 * Counts one API request in the session tally, by host and by kind.
 *
 * @param {string} url The request URL.
 * @param {string} [kind] What the request was for, 'other' when absent.
 */
export function countApiRequest(url, kind) {
    requestTally.api.total += 1;
    const host = hostOf(url);
    requestTally.api.byHost[host] = (requestTally.api.byHost[host] || 0) + 1;
    const k = kind || 'other';
    requestTally.api.byKind[k] = (requestTally.api.byKind[k] || 0) + 1;
    scheduleTallyRender();
}

/**
 * Counts one image load in the session tally and records its outcome in the request log.
 *
 * @param {string} url The image URL.
 * @param {string} kind What the image was.
 * @param {boolean} ok Whether it loaded.
 */
export function countImageRequest(url, kind, ok) {
    requestTally.images.total += 1;
    const host = hostOf(url);
    requestTally.images.byHost[host] = (requestTally.images.byHost[host] || 0) + 1;
    logRequest({ url, kind, at: Date.now(), bytes: null, ok });
    scheduleTallyRender();
}

// The reader's request log, beside the tally. It records a request when its outcome is known and keeps each URL's origin and purpose, never the URL.
let requestLog = recordRequest(null, null);

/**
 * Records one request in the reader's request log, which keeps its origin and purpose and never its URL.
 *
 * @param {Object} request The request record passed to the request log.
 */
export function logRequest(request) {
    requestLog = recordRequest(requestLog, request);
}

// Both counters can land while the panel is open, so the tally redraws, coalesced through a timeout so a burst of avatars redraws it once.
let tallyRenderQueued = false;
function scheduleTallyRender() {
    if (tallyRenderQueued) return;
    tallyRenderQueued = true;
    setTimeout(() => {
        tallyRenderQueued = false;
        if (diagnosticPanelEnabled && document.getElementById('debug-panel')?.open) renderRequestTally();
    }, 0);
}

/**
 * Returns the session's live request tally.
 *
 * @returns {{startedAt: number, api: Object, images: Object}} The tally; callers must not mutate it.
 */
export function getRequestTally() {
    return requestTally;
}

// SWID comparison tolerant of the brace-wrapped and case forms ESPN uses in different places.
function sameSwid(a, b) {
    const norm = (s) => String(s || '').replace(/[{}]/g, '').toUpperCase();
    return !!a && !!b && norm(a) === norm(b);
}

/**
 * Finds the team the signed-in user owns by matching the SWID cookie against each team's owners.
 *
 * @param {Array<Object>} teams The league's teams.
 * @param {string} swid The SWID cookie value.
 * @returns {number|null} The team id, or null when the user owns none.
 */
export function findOwnedTeamId(teams, swid) {
    if (!swid) return null;
    const owned = (teams || []).find(t =>
        (t.owners || []).some(o => sameSwid(o, swid)) || sameSwid(t.primaryOwner, swid));
    return owned ? owned.id : null;
}

/**
 * Resolves "my team" for every face. It is the owned team, else the first team in the standings.
 *
 * @param {Array<Object>} teams The league's teams.
 * @param {string} swid The SWID cookie value.
 * @param {Array<{id: number}>} teamStats Teams in standings order.
 * @returns {{id: (number|null), isStandIn: boolean}} The id and whether it is a stand-in rather than an owned team.
 */
export function resolveMyTeamId(teams, swid, teamStats) {
    const owned = findOwnedTeamId(teams, swid);
    if (owned != null) return { id: owned, isStandIn: false };
    const standInId = (teamStats && teamStats.length) ? teamStats[0].id : null;
    return { id: standInId, isStandIn: standInId != null };
}

/**
 * Gives a team's on-screen name, the reader's nickname when one is set.
 *
 * @param {{id: (number|string), name: string}|null} team The team.
 * @returns {string} The name, or an empty string for no team.
 */
export function displayTeamName(team) {
    if (!team) return '';
    const nick = AppState.nicknames.get(String(team.id));
    return nick || team.name;
}

/**
 * Words where a player was drafted, the same way for the drill-down and the roster row.
 *
 * @param {Array<Object>} picks The league's draft picks.
 * @param {number|string} playerId The player.
 * @param {Array<Object>} teams The league's teams, for the drafting team's name.
 * @returns {string} "Undrafted", or a sentence naming the round, the pick and the team.
 */
export function draftedFactText(picks, playerId, teams) {
    const pick = draftPickOf(picks, playerId);
    if (!pick) return 'Undrafted';
    const team = pick.teamId != null ? displayTeamName((teams || []).find(t => t.id === pick.teamId)) : '';
    const teamPart = team ? `, by ${team}` : '';
    if (pick.round != null && pick.overallPickNumber != null) {
        return `Drafted round ${pick.round}, pick ${pick.overallPickNumber}${teamPart}`;
    }
    if (pick.round != null) return `Drafted round ${pick.round}${teamPart}`;
    return `Drafted${teamPart}`;
}

/**
 * Gives a player's pick as three whole numbers.
 *
 * @param {Array<Object>} picks The league's draft picks.
 * @param {number|string} playerId The player.
 * @param {number} teamCount The number of teams, needed for the slot.
 * @returns {{round: (number|null), slot: (number|null), overall: (number|null)}|null} The parts, or null for an undrafted player.
 */
export function draftedPickParts(picks, playerId, teamCount) {
    const pick = draftPickOf(picks, playerId);
    if (!pick) return null;
    const round = pick.round != null ? Number(pick.round) : null;
    const overall = pick.overallPickNumber != null ? Number(pick.overallPickNumber) : null;
    const teams = Number(teamCount);
    let slot = null;
    if (round !== null && overall !== null && Number.isFinite(teams) && teams > 0) {
        const within = overall - (round - 1) * teams;
        if (within >= 1 && within <= teams) slot = within;
    }
    return { round, slot, overall };
}

/**
 * Finds which team took a player.
 *
 * @param {Array<Object>} picks The league's draft picks.
 * @param {number|string} playerId The player.
 * @returns {number|null} The drafting team's id, or null when unknown.
 */
export function draftedPickTeamId(picks, playerId) {
    const pick = draftPickOf(picks, playerId);
    return pick && pick.teamId != null ? Number(pick.teamId) : null;
}

/**
 * Scrolls a player's cell in the Draft tab's recap board into view and flashes it, looking for up to two seconds.
 *
 * @param {number|string} playerId The player.
 */
export function revealDraftPick(playerId) {
    const started = performance.now();
    const look = () => {
        const cell = document.querySelector(`#view-draft [data-player-id="${String(playerId)}"]`);
        if (cell) {
            cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
            cell.classList.add('dr-pick-flash');
            setTimeout(() => cell.classList.remove('dr-pick-flash'), 2200);
            return;
        }
        if (performance.now() - started < 2000) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
}

/**
 * Gives the ESPN name for a hover, only when a nickname stands in for it.
 *
 * @param {{id: (number|string), name: string}|null} team The team.
 * @returns {string} The ESPN name, or an empty string when there is no nickname.
 */
export function teamNameTitle(team) {
    if (!team) return '';
    return AppState.nicknames.get(String(team.id)) ? team.name : '';
}

// The surname is the last token of a name, skipping a generational suffix, so a name ending in Jr. reads as the word before it.
const GENERATIONAL_SUFFIXES = new Set(['Jr.', 'Jr', 'Sr.', 'Sr', 'II', 'III', 'IV']);
/**
 * Takes a name's surname, skipping a generational suffix such as Jr. or III.
 *
 * @param {string} name A full name.
 * @returns {string} The surname, or an empty string for an empty name.
 */
export function surnameOf(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    let idx = parts.length - 1;
    if (parts.length > 1 && GENERATIONAL_SUFFIXES.has(parts[idx])) idx -= 1;
    return parts[idx];
}
