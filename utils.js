import { AppState, PITCHING_IDS, GOALIE_IDS, ESPN_STAT_MAPS, ESPN_STAT_FULL_NAMES, SPORT_NAMES } from './state.js';
import { buildZip } from './zip.js';

// Role-grouped ordering for any list of stat ids that can mix roles. Batting comes before pitching (flb), skaters before goalies (fhl). A STABLE partition, so the caller's own relative order survives within each group - a league's scoring-item order (or the stat map's order) still decides everything except which side of the split a category lands on. Driven by the same validated role sets the app already splits its group tabs by, so this adds no stat knowledge. Why it is needed. Displayed order used to be whatever the source happened to produce, and those sources interleave the roles. Object.keys returns integer-like keys in ASCENDING NUMERIC order no matter how the stat map is written, so baseball's fielding ids (67-73, batting-group stats) sort after the whole pitching block, and hockey's goalie ids (0-11) sort BEFORE every skater id - which is why the hockey heatmap led with W/SO/GAA/SV%. A league's scoringItems order (AppState.scoredStatIds, what the recap walks) interleaves them freely too. A single-role league is unaffected by construction. Everything lands in one group, so the output is the input, in the input's order. A sport with no static table falls back to whatever the LEAGUE said - see AppState's secondaryStatIds. Baseball and hockey keep their tables and are unaffected.
const ROLE_ID_SETS = { flb: PITCHING_IDS, fhl: GOALIE_IDS };
// EXPORTED, because this ternary had been written out SIX TIMES in players.js - the repeated role split the consistency audit counted - and every copy returned an empty set for a sport with no static table, which is why football's defensive columns were absent even after its ids were named. One definition, and a new sport reaches every one of those six places at once.
export const roleIdSetFor = (sport) => ROLE_ID_SETS[sport] || AppState.secondaryStatIds || new Set();

export function splitStatIdsByRole(sport, statIds) {
    const secondaryIds = roleIdSetFor(sport);
    const primary = [], secondary = [];
    statIds.forEach(id => {
        // String(id) - callers hand us ids as strings (Object.keys, scoredStatIds) or as numbers (availableStatsSet), while the role sets are string-keyed.
        if (secondaryIds && secondaryIds.has(String(id))) secondary.push(id);
        else primary.push(id);
    });
    return { primary, secondary };
}

export function orderStatIdsByRole(sport, statIds) {
    const { primary, secondary } = splitStatIdsByRole(sport, statIds);
    return [...primary, ...secondary];
}

// ESPN occasionally reports a stat value as {value: X} instead of a raw number (seen in both the team-level valuesByStat payload and player stat lines) - most often for players/seasons with no actual games played yet (e.g. drilling into a future/preseason year). Unwrap consistently wherever a raw stats map comes off the wire, in either data.js (teams) or players.js (players). `v && typeof v === 'object'` (not just `typeof v === 'object'`) is deliberate - typeof null is 'object' too, and ESPN does send null for some unrecorded stats.
export function statValue(v) {
    return (v && typeof v === 'object') ? v.value : v;
}

// JSON has no way to write an infinite number, so ESPN sends the STRING "Infinity" for a rate stat whose denominator is still zero. That is a real value, not corrupt data. A team with earned runs and no innings yet genuinely has an infinite ERA, and it shows up on the live matchup precisely because the denominator has not caught up. VALIDATED in a real league mid-matchup, where stat 47 arrived as "Infinity" for one team. Every category value goes through here on the way in, so nothing downstream has to think about it. A string that is a number becomes a number, "Infinity" becomes real Infinity, and anything that is not a number at all becomes null rather than NaN, since null already means "no value" everywhere in this app while NaN poisons arithmetic silently.
export function numericStat(v) {
    const raw = statValue(v);
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
}

export function unwrapStats(rawStats) {
    const result = {};
    Object.keys(rawStats || {}).forEach(id => { result[id] = statValue(rawStats[id]); });
    return result;
}

// Returns the first argument that isn't undefined - for the handful of ESPN payload shapes that use different field names for "the real value" depending on context (boxscore stats prefer appliedTotal over value; cumulativeScore stats prefer score over value).
export function firstDefined(...values) {
    return values.find(v => v !== undefined);
}

// THE LIVE MATCHUP TALLY. `cumulativeScore` counts FINALIZED DAYS ONLY - it is correct every morning and frozen all day, which is what the owner watched: a 6-6-2 that never moved while ESPN's own page climbed. ESPN answers this with a second block, `cumulativeScoreLive`, carrying the same shape with today's in-progress values folded in, and it ships in the payload the app already asks for - no extra view, no extra parameter. VALIDATED ACROSS EVERY CAPTURE IN JSON_debug, not assumed (golden rule 4 applies to field meanings as much as to stat ids): - The live block exists on EXACTLY the current matchup and on no other, in all eleven captures that carry one. So "the live block is present" IS "this matchup is in progress" - there is no need to work out which matchup is live to decide which number to trust. - In four mid-day captures it genuinely differs from the rollup (6-5-3 against 6-6-2 in one), and its scoreByStat carries higher per-category scores (a 10 that reads 13 live). In the rest the two agree, which is what a capture taken between days should look like. - Roto leagues never carry one. They have no matchup to be live in. So the rule is: prefer the live block when it is there, fall back to the rollup when it is not, and a completed matchup is untouched because ESPN does not attach a live block to one. That is what keeps the authoritative number authoritative everywhere it is read.
export function matchupTally(side) {
    if (!side) return null;
    const live = side.cumulativeScoreLive;
    // A `wins` that is a real number is the test, not mere presence - an empty object would otherwise shadow a perfectly good rollup with nothing.
    if (live && typeof live.wins === 'number') return live;
    return side.cumulativeScore || null;
}

// The points-league twin, and the same preference. HONESTLY UNPROVEN: no capture in JSON_debug shows totalPoints and totalPointsLive disagreeing, so unlike the category tally there is no direct evidence that the plain field is finalized-only here. What there is: ESPN ships the two fields in exactly the parallel shape it ships the category pair, and it does not ship two names for one number without a reason. Preferring the live one is either identical (no harm on every capture measured) or more current (the fix), so it is the defensive read either way.
export function matchupPoints(side) {
    if (!side) return 0;
    const live = side.totalPointsLive;
    return (typeof live === 'number' ? live : side.totalPoints) || 0;
}

// WHICH MATCHUPS THE SCHEDULE READER TAKES. PURE. The last matchup with a score on the board, PLUS the one being played right now. That second half is the fix: the reader used to stop at maxCompletedWeek, and maxCompletedWeek deliberately does not advance until the rollup shows a result (see its own note in data.js, and the reason it must stay that way - a barely-started matchup is not a completed one). So on the first morning of a matchup the live game was skipped entirely, no weeklyCats row was written for it, and the Current timeframe aggregated nothing and rendered 0-0 while the header, reading the live block straight off the schedule, correctly showed 3-0-11. Two numbers rather than one, because they answer different questions and always did. "How far has the season got" still ends at the last finished matchup, which is what every span and lookback window is measured against. "What is there to read" now includes today. currentMatchup is 0 once the season is over (see AppState.currentMatchup), so the max collapses back to maxCompletedWeek on a finished season with no special case.
export function readsAsPlayedMatchup(week, maxCompletedWeek, currentMatchup) {
    return week <= Math.max(maxCompletedWeek || 0, currentMatchup || 0);
}

// One side's match RESULT, or null when there is not one yet. PURE. The 1/0.5/0 encoding has no way to say "not finished" - a zero means LOST - and the schedule loop admits the live matchup so Current can read it, whose winner is UNDECIDED. Writing its result booked a loss for both sides and every record on the page read one loss high, which is how the owner caught it. Null is the honest fourth value: no result exists until the winner does, and every record reader already skips a week with no entry.
export function matchResultOf(game, side) {
    if (!game || !game[side]) return null;
    const winner = game.winner;
    if (winner === 'TIE') return 0.5;
    if (winner !== 'HOME' && winner !== 'AWAY') return null;
    return winner === side.toUpperCase() ? 1 : 0;
}

// One side's per-category values for a matchup, off the SAME matchupTally the header reads. PURE. This is what makes "Current agrees with the header" true by construction rather than by two call sites happening to agree today. Both go through matchupTally, so both prefer cumulativeScoreLive when it is there and both fall back to the rollup when it is not - there is no arrangement of the payload in which they can disagree, which is the class of bug this kills rather than the instance. scoreByStat is keyed by stat id and each entry carries its own statId, so the key is used only when the entry does not name itself. statBySlot is the older shape and is read the same way.
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

// Splits a list of stat ids into "scored" (this league's settings actually use them) and "advanced" (everything else ESPN happens to track), shared between the Team Metrics category filter and every Player Metrics view so the same league config drives what's visible everywhere. forceScored lets a caller pin specific ids (e.g. FPTS) into the visible set regardless of whether the league's own scoringItems formally lists them.
export function splitScoredAdvanced(ids, forceScored = new Set()) {
    if (AppState.scoredStatIds.size === 0) return { scored: ids, advanced: [] };

    const scored = ids.filter(id => AppState.scoredStatIds.has(id.toString()) || forceScored.has(id));
    // None of this group's ids match scoredStatIds at all - the league's scoringItems ids aren't lining up with our stat map (or there was nothing to match against). Fall back to showing everything rather than presenting what looks like an empty list.
    if (scored.length === 0) return { scored: ids, advanced: [] };

    const scoredSet = new Set(scored);
    return { scored, advanced: ids.filter(id => !scoredSet.has(id)) };
}

// The ordered list of categories the Category Rankings pager cycles through, and the count of the ones it is currently leaving out. Lives here rather than in controls.js because graphs.js needs it too and the controls -> graphs import is one-directional. Order is role-grouped (batting before pitching, skaters before goalies) so cycling walks the same grouping every other surface displays, and the list is deduplicated by NAME because ESPN's stat map carries a few aliases that would otherwise show up as two identical-looking categories. Scope: the league's SCORED categories by default, extended to everything ESPN tracks when AppState.showAdvancedStats is on. Measured on the 6-team fixture, that is 14 categories versus 24 - which is exactly why the advanced set stays behind a toggle instead of being folded into the cycle: at one category per screen, ten of those extra twenty-four are categories the league does not even score, and every one of them is another arrow press away from the ones it does.
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

// The ONE x-axis vocabulary for the current league type. Every graph axis, span label and tooltip that names a point on the time axis reads it from here, so a screen can never mix tokens. It is per LEAGUE TYPE rather than one global word because the units genuinely differ, and picking either word globally would make the other league type lie. H2H graphs index MATCHUPS, and a playoff matchup can span two or three real weeks (the league-data quirk the whole timeframe system is built around), so calling one a week is factually wrong. Roto has no matchup periods at all - chose real weeks for its axis deliberately - so calling one a matchup is equally wrong. Days are NOT here. The matchup race cards plot real scoring days, which is a third and correct unit that both league types share, so those keep their own "Day N".
export function axisUnit() {
    return AppState.isRotoLeague
        ? { short: 'WK', long: 'Week', plural: 'Weeks' }
        : { short: 'M', long: 'Matchup', plural: 'Matchups' };
}

// THE LEAGUE-TYPE BADGE. scoringType -> { label, tooltip }, so the top bar always says what kind of league is loaded, not just whether it happens to be points or roto (AppState.isPointsLeague/ isRotoLeague collapse five real ESPN formats into two booleans, which is enough to pick a rendering PATH but not enough to name the format on screen). VALIDATED against real payloads per the golden rule 4 spirit: H2H_MOST_CATEGORIES, H2H_POINTS and ROTO are all confirmed sighted (a baseball league, a points hockey league, a hockey roto capture); H2H_EACH_CATEGORY and TOTAL_SEASON_POINTS are ESPN-documented but unconfirmed against a capture here - included on the same footing as the confirmed three rather than guessed at differently, since ESPN's own enum is the source either way and the fallback below already covers anything this map gets wrong. Pure and exported on its own so a test can assert every label without rendering anything - the mapping is the part with real formats to get right or wrong, not the DOM node it ends up in.
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

// An unrecognized scoringType shows the raw value rather than nothing - the backlog's own acceptance rule, and the same defensive-parsing spirit as every ESPN enum this codebase reads (golden rule 8). `type` may be missing entirely on a payload that predates the field.
export function leagueTypeBadge(type) {
    if (!type) return null;
    const known = SCORING_TYPE_BADGES[type];
    if (known) return known;
    return { label: type, tooltip: `An ESPN scoring format this app does not yet have a name for (${type}).` };
}

// A category's header label: the abbreviation with its spelled-out name after it, "W (Wins)" or "+/- (Plus Minus)". The abbreviation stays FIRST because it is what the rest of the app shows (the heatmap columns, the race hover, the export) and what the reader is matching against; the words are the gloss, not the replacement. Falls back to the abbreviation alone for any id without a documented expansion, which is what every surface showed before.
export function categoryHeaderLabel(sport, statId, shortName) {
    const full = (ESPN_STAT_FULL_NAMES[sport] || {})[statId];
    return (!full || full === shortName) ? shortName : `${shortName} (${full})`;
}

// How many categories the Advanced Stats toggle would ADD - the toggle's label, and zero means the league scores everything ESPN tracks for it, so the toggle has nothing to offer and hides itself.
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

export function getZoomedFillPct(val, min, max) {
    if (min === max) return val > 0 ? 100 : 0;
    const range = max - min;
    let baseline = min - (range * 0.15);
    if (min >= 0 && baseline < 0) baseline = 0;
    const adjustedMax = max - baseline;
    if (adjustedMax === 0) return 0;
    return Math.max(0, ((val - baseline) / adjustedMax) * 100);
}

// Resolves the one shared AppState.timeframe value (see rebuildTimeframeOptions in controls.js, the only place that ever produces a value here) into a [start, end] week range - used by Team Metrics graphs, the Player Metrics leaderboard, and the player drill-down chart alike. PURE. A timeframe value is two independent choices, not one. WHICH PART of the season, and HOW RECENT a stretch within it. They are stored as "span" or "span+lastN" so the two segmented controls in the tab bar each own one of them. Before this they were one flat list, which left a real question unanswerable: "the last 4 matchups of the REGULAR season" was neither "Regular Season" (all of it) nor "Last 4" (which reaches back from the playoffs and mixes the two). A bare "lastN" still parses, so a timeframe stored by an older session restores as a full-season lookback rather than being dropped.
export function parseTimeframe(tfVal) {
    const parts = String(tfVal || 'all').split('+');
    const head = parts[0];
    if (head.startsWith('last')) return { span: 'all', window: parseInt(head.slice(4), 10) || null };
    const tail = parts[1];
    const window = tail && tail.startsWith('last') ? (parseInt(tail.slice(4), 10) || null) : null;
    return { span: head, window };
}

// currentWk is status.currentMatchupPeriod, the matchup being played right now. It moves ONE pill, "Current", and only on the morning before that matchup's first game. Until something is scored, maxWk still points at the matchup that just ended, so that pill showed the previous one's production. Once any game is scored the two agree again on their own. Every other window is retrospective and ends at the last COMPLETED matchup, by the owner's rule: "Last 4" is four finished matchups, not three and whatever has happened so far today. The live anchor is accepted only when it is exactly one past maxWk, which is what "live matchup, nothing scored yet" looks like, and only for a span that actually reaches the end of the season - the regular season's last 4 do not move because a playoff matchup started.
export function getTimeframeBounds(tfVal, maxWk, regWks, currentWk = 0) {
    const { span, window: n } = parseTimeframe(tfVal);

    let start = 1;
    let end = maxWk;
    if (span === 'reg') end = Math.min(maxWk, regWks);
    else if (span === 'p_all') start = regWks + 1;

    if (n) {
        // The live matchup only extends a span that CONTAINS it. On the morning of the first playoff matchup, "Current" inside the regular season must stay on the regular season's last matchup rather than jumping to a playoff one that is not in the span.
        const spanHoldsLive = span === 'reg' ? currentWk <= regWks : true;
        if (n === 1 && spanHoldsLive && currentWk === maxWk + 1) end = currentWk;
        start = Math.max(start, end - n + 1);
    }
    return { start, end };
}

export function getNiceMax(val) {
    if (val <= 0) return 4;
    if (val >= 4) {
        let step = Math.ceil(val / 4);
        if (step > 10) step = Math.ceil(step / 5) * 5;
        return step * 4;
    }
    // Rate-style stats (a weekly AVG, ERA, etc.) are usually well under 4, but the formula above floors every val < 4 up to a fixed max of 4 regardless of how much smaller the real max is - squashing a chart whose highest point is, say, 1.000 into a quarter of the available height. Scale the same "round up to a quarter-step" idea down by powers of 10 instead of using a fixed step of 1.
    let unit = 1;
    while (val < unit) unit /= 10;
    const step = Math.ceil(val / (unit / 4) + 0.5);
    return step * (unit / 4);
}

// Lightens (positive percent) or darkens (negative percent) a hex color.
export function shadeColor(hex, percent) {
    const f = parseInt(hex.slice(1), 16);
    const t = percent < 0 ? 0 : 255;
    const p = Math.abs(percent) / 100;
    const R = f >> 16, G = (f >> 8) & 0x00FF, B = f & 0x0000FF;
    const toHex = (c) => Math.max(0, Math.min(255, Math.round((t - c) * p) + c)).toString(16).padStart(2, '0');
    return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
}

// A stat percentile (0-100), clamped and handed to CSS as a NUMBER rather than as a colour. The colour is mixed from --success / --danger / --surface in the sheet, which is the only way a tint can follow the theme - see.dh-cell in dashboard.css. This replaces percentileColor, which interpolated hardcoded rgb() in here: white at the 50th percentile, pastel green above, pastel red below. It had no dark half and could not have one, because a function in a JS module cannot see which mode is on. So the heatmap and the drill-down's stat chips were a light-mode island - white-to-pastel cells, with a near-black text colour pinned in CSS to survive them - and in dark mode they sat on the page as a bright slab with the page's own light-on-dark structure inverted inside it. Golden rule 3 says colours come from custom properties, and it never caught this because the rule reads as a CSS rule and these colours were in a JS file. Worth remembering: the rule is about where a colour is DECIDED, not about which file it is typed in.
export function percentileVar(pct) {
    return Math.max(0, Math.min(100, Number(pct) || 0));
}

// Every played week is tagged with a bracket tier when the schedule is processed (see data.js) - 'reg', 'playoff' (real championship bracket), or 'consolation'.
export function getWeekTier(team, week) {
    return team.weeklyTier?.[week] || 'reg';
}

export function tierColor(tier, baseColor) {
    if (tier === 'playoff') return shadeColor(baseColor, -25);
    if (tier === 'consolation') return shadeColor(baseColor, 45);
    return baseColor;
}

// Splits a per-week value series into how much came from regular season vs. each playoff tier, so bar charts can show the breakdown as a single gradient fill.
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

// ESPN's injuryStatus, mapped to what a person would call it. Every token here was counted in real captures rather than taken from a reference: across eight payloads covering both sports and the 2024, 2025 and 2026 seasons, baseball reports ACTIVE, DAY_TO_DAY, SEVEN_DAY_DL, TEN_DAY_DL, FIFTEEN_DAY_DL and SIXTY_DAY_DL, while hockey reports ACTIVE, OUT, INJURY_RESERVE and SUSPENSION. MLB renamed the disabled list to the injured list in 2019 and ESPN kept the old key, so the label says IL while the key still says DL.
export const INJURY_STATUS_LABELS = {
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

// Anything ESPN sends that is not in the table above still gets a badge, labelled with ESPN's own word rather than a guess at what it means. Titlecasing the token is the honest fallback. A status we have never seen is a reason to show something, not to stay silent about an unavailable player.
export function injuryLabel(status) {
    if (!status || status === 'ACTIVE') return '';
    return INJURY_STATUS_LABELS[status]
        || String(status).toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

// The shared availability badge, used by the leaderboard, the roster and the drill-down so all three say the same thing in the same colour. Returns empty for a healthy player, which lets every call site interpolate it unconditionally.
export function injuryBadgeHtml(status) {
    const label = injuryLabel(status);
    if (!label) return '';
    const tier = INJURY_MINOR.has(status) ? 'minor' : 'major';
    return `<span class="injury-icon injury-${tier}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${injuryGlyph(status)}</span>`;
}

// The one sentence every surface uses when the player pool is missing. Shared so the leaderboard and My Team cannot drift into telling the same user two different stories, and so the logged-out case reads as a thing to DO rather than as a status code. Callers escape it.
export function playerPoolErrorText(err) {
    if (err && err.authRequired) return 'Log into ESPN in this browser to load player data, then refresh.';
    return `Couldn't load player data: ${(err && err.message) || 'Unknown error'}`;
}

// Escapes the five HTML-significant characters. Single quotes are included so a value is safe in a single-quoted attribute too, not just double-quoted - team and player names are set by league members, so every interpolation of them into an innerHTML template must run through this. (Read sites that pull escaped values back OUT of an attribute must use textContent, not innerHTML, or they re-decode and re-arm the markup - see attachDataTooltips.)
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// THE LOADING STATE. One shared component, everywhere the app is waiting on something - so a fetch in progress reads as one consistent language rather than a different sentence per surface. "Loading", the exact word VOICE.md's own blunt-states example gives, never a per-site phrase ("Building the Roto Race...", "Checking cookies...") - those said WHAT was loading, which reads as narration this codebase's own house style otherwise avoids (VOICE's "detail lives behind the click"), and meant a reader learned a new sentence per surface instead of one mark that always means the same thing. The icon is themed off document.documentElement's own data-sport attribute (setSportAttribute, data.js - the same one Boxscore's ballpark/rink shapes already key off, ), so this function needs no sport argument of its own; it reads the CSS to draw whatever the loaded league already told it. Before any league has loaded (the auth-check state, before data-sport exists) the CSS's own fallback is a plain pulsing mark - not a guess at a sport nobody has picked yet.
export function buildLoadingHtml() {
    return `<div class="loading-state"><span class="loading-icon" aria-hidden="true"></span><span class="loading-text">Loading</span></div>`;
}

export function ensureFloatingTooltip() {
    let el = document.getElementById('floating-tooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'floating-tooltip';
        el.style.cssText = 'position:fixed; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:8px 12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:normal; max-width:360px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(el);
    }
    return el;
}

// Lays out a chart hover tooltip's team rows so a large league's readout can't clip, and positions it. The Season Trends and Roto Race hovers both list one row per visible team at the hovered point. The old code positioned the tooltip inside the CHART box and clamped it there; in a 20-team league those 20 rows ran taller than the box (short at that width - measured 125px on a 20-team trend chart), so the clamp just shoved the overflow off the top edge where it was cut off. Two changes fix it. The tooltip is positioned relative to the VIEWPORT (it is position:fixed), so it can use the whole window height a short chart box denied it - which alone shows all 20 in one column at a normal desktop size. And when even the viewport can't fit one column (a short window), the rows REFLOW into columns. Column-major fill (grid-auto-flow: column) keeps the callers' best-first sort reading as a mini-standings, rank 1 top-left counting down each column. The team list is never truncated - a "+N more" in a tooltip is the same bug banned in boxes. tooltipEl must be position:fixed and contain a `.tt-rows` wrapper around the per-team rows (plus an optional `.tt-header`). clientX/clientY are the cursor's viewport coordinates.
export function layoutHoverTooltip(tooltipEl, clientX, clientY) {
    const rowsEl = tooltipEl.querySelector('.tt-rows');
    // Start every measurement from the natural single column - a previous mousemove may have left a grid reflow on the shared element, and this point may need fewer columns (or none).
    if (rowsEl) {
        rowsEl.style.display = '';
        rowsEl.style.gridAutoFlow = '';
        rowsEl.style.gridTemplateRows = '';
        rowsEl.style.columnGap = '';
    }

    const margin = 12;
    const availH = window.innerHeight - margin * 2;

    if (rowsEl && rowsEl.children.length > 1) {
        // Average the stacked column's full height across the rows, so the per-row figure includes each row's margin - offsetHeight alone misses the 4px gap between rows and packed columns too tightly, leaving the reflowed tooltip still overflowing.
        const rowH = (rowsEl.scrollHeight / rowsEl.children.length) || 18;
        const headerH = tooltipEl.querySelector('.tt-header')?.offsetHeight || 0;
        // Height the rows may fill: the viewport, minus the header, the tooltip's own vertical padding, and a small safety gap. Column-major, so the number of rows PER column is the lever - fewer rows per column means more columns side by side.
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

// The explanatory ⓘ tooltips on panel headings. They used to be a second tooltip implementation, absolutely positioned INSIDE the header and centred on their trigger, which is what was: a 250px box hanging 125px right of a trigger near the right edge, still counted in the page's scrollable width even while hidden, so the page scrolled sideways because of something nobody could see - and the horizontal scrollbar that raised then ate 15px of height and brought vertical scroll back with it. Measured at 1024 wide it was 13px, at 961 it was 38px. Fixed positioning is the actual fix. A fixed element is out of flow and cannot extend the page at all, at any width. Clamping to the viewport comes along with it, so a tooltip near an edge stays readable rather than being cropped. Text, never markup. The hint is written as an attribute and read back with textContent, so a heading can never smuggle HTML into the page (the same rule attachDataTooltips documents). Line breaks survive as real newlines in the attribute via white-space: pre-line.
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

// phase M2 item 6: hover does not exist on a coarse (touch) pointer, and this codebase has no second copy of that fact to keep in sync - every consumer already funnels through this function or attachDataTooltips below, so the touch form lives here once rather than once per surface. matchMedia is read PER EVENT, not cached at setup, since a hybrid device (a touchscreen laptop) can genuinely use either pointer type from one page load to the next.
export function isCoarsePointer() {
    return window.matchMedia('(pointer: coarse)').matches;
}

let openHintTarget = null;

// Delegated from the document, so hints inside re-rendered panels keep working without every render remembering to re-bind. Focus and blur are included to keep the ⓘ usable from a keyboard.
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
    // mouseover/mouseout are a COARSE POINTER'S OWN NO-OP now: a tap can synthesize a trailing mouseover on some mobile browsers, and without this guard that synthetic event would show a tooltip the tap handler below is about to show (or hide) anyway, racing it. Focus/blur stay unconditional - a coarse-pointer device with an attached keyboard still benefits from them, and tabbing to an element is a real, deliberate action either pointer type can take.
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
    // TAP TO SHOW, TAP ELSEWHERE TO DISMISS. A second tap on the SAME trigger closes it (the disclosure convention every phone keyboard and menu already uses); a tap on a DIFFERENT trigger closes whatever was open and opens the new one rather than stacking two tooltips; a tap anywhere else just closes. preventDefault on the trigger tap stops a synthetic click from also firing on whatever the ⓘ/pill/chip sits on top of - the tooltip is the whole point of that tap, not a side effect of it.
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

// Wires up a floating tooltip for every [data-tooltip] element inside container. Used for bar segments (and pie slices) so each hoverable region can show its own text - stopping propagation means a segment's tooltip wins over any ancestor's, rather than both firing. TOUCH: a coarse pointer gets tap-to-show/tap-elsewhere-to-dismiss, the same convention setupHintTooltips uses for [data-hint]. attachDataTooltips is called fresh on EVERY render of whatever chart or bar it wires (not once at startup the way setupHintTooltips is), so the per-element show/hide listeners below are fine to re-add each time - the old elements they were bound to are gone with the old DOM - but the document-level "tap elsewhere dismisses" listener is wired exactly once (the module-level flag), or every re-render would stack another one.
export function attachDataTooltips(container) {
    if (!container) return;
    const tooltipEl = ensureFloatingTooltip();

    const showAt = (el, x, y) => {
        // Text-only on purpose. getAttribute DECODES the entities the write sites escaped, so piping it back through innerHTML re-armed hostile markup in team names (the classic escape-then-unescape hole). Building the <strong> as a node and setting textContent keeps the styling with zero HTML parsing of attacker-reachable text.
        tooltipEl.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = el.getAttribute('data-tooltip');
        tooltipEl.appendChild(strong);
        tooltipEl.style.display = 'block';
        // Same clamp-and-flip layoutHoverTooltip already does for the chart hovers - a long joined tip (the pacing note's per-category breakdown, item 10) now wraps at max-width instead of running past the viewport edge, so it needs the same margin logic rather than the raw cursor+15 offset this used while it was one nowrap line.
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
        // A second tap on the same region closes it - both segment and hint tooltips agree on that convention. Positioned off the region's own centre rather than a cursor point, which a tap has none of.
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

// THE RANK EXPLAINER'S TOUCH FORM..rank-chip/.stat-chip reveal their own dropdown on `:hover`, which a tap cannot sustain - a delayed hover-and-wait on desktop, entirely unreachable on a phone. A quick tap on.rank-chip already switches which pool the page explains (players.js), so tap itself could not become "open the dropdown" without breaking that - a touch-and-hold is the honest equivalent of "hover and wait" a click can never be confused with. Delegated from the document, once, the same shape setupHintTooltips takes.
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

    document.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        const target = e.target.closest?.(SELECTOR);
        if (!target) return;
        pressTarget = target;
        timer = setTimeout(() => {
            clearOpen();
            target.classList.add(OPEN_CLASS);
            timer = null;
        }, HOLD_MS);
    });
    // A finger that lifts or drags before the hold completes was a tap or a scroll, not a long press - cancelled rather than opened, the same way a browser's own long-press gestures work.
    document.addEventListener('pointerup', cancelTimer);
    document.addEventListener('pointercancel', cancelTimer);
    document.addEventListener('pointermove', (e) => {
        if (timer && e.target.closest?.(SELECTOR) !== pressTarget) cancelTimer();
    });
    // A tap anywhere outside the open chip closes it - including a quick tap on the SAME chip, which already runs its own click handler (switching pools) and should not also leave the dropdown standing open over the page it just changed.
    document.addEventListener('click', (e) => {
        if (!isCoarsePointer()) return;
        if (!document.querySelector(`.${OPEN_CLASS}`)) return;
        clearOpen();
    });
}

// The Diagnostic Data panel shows exactly ONE of three contexts at a time - team schema (Team Metrics tab), the player pool (Player Metrics leaderboard, not drilled into a player), or one player's own detail (an open drill-down) - matching whatever the user is actually looking at. Previously every fetch just overwrote a single shared slot last-write-wins, so a background prefetch (the player pool warms up as soon as league data loads - see prefetchPlayerData in players.js) could silently clobber the team schema before the user ever switched tabs, and a background weekly-stats refetch could clobber an open drill-down's own debug mid-view. Each kind's payload is tracked independently; setActiveDebugKind (called on every tab switch and drill-down open/close - see main.js and players.js) decides which one is currently shown. A fourth kind, player-weekly, exists because the leaderboard's bulk weekly fetch used to write its first chunk into the POOL slot. The panel then offered a 75-player weekly chunk under the label "Player Pool Schema", and a download taken to inspect the pool silently produced daily splits for whichever rows happened to be on screen. Two captures taken minutes apart came back byte-identical while claiming to be different things, which is how it was found. Each response now sits under its own name.
const DEBUG_LABELS = {
    team: 'Team Schema',
    'player-pool': 'Player Pool Schema',
    'player-weekly': 'Weekly Stats Chunk',
    'player-detail': 'Player Detail Schema',
    // The leagueHistory array: one entry per season the league has existed for. Captured so the shape can be read off a real league, which is the open question League History was built around - it fetches each past season directly rather than trust an unmeasured shape.
    'league-history': 'League History Schema',
    // mRoster, the one view the extension reads that no other kind captures: it is where a lineupSlotId lives, and every roster surface is built on that field. Written by fetchRosterPeriod, which BOTH the single call and the ~196-request season harvest run through, so during a harvest this holds whichever period landed last. That is the player-weekly hazard above in miniature - two captures minutes apart claiming to be the same thing - and the reason it is a kind of its own rather than a second writer into an existing slot: a download taken here is always an mRoster response, whatever period it turns out to be.
    roster: 'Roster Schema',
    // THE REST OF WHAT THE APP FETCHES (ruled: everything we ever need debugging-wise joins this panel, so one Download All carries the whole picture and a capture ask is one instruction rather than a choreography). Each is written at its own fetch's success path. Two of these only ever hold something the app fetched for its OWN reasons: 'transactions' is one slice of a ~196-request harvest, and 'history-pool' one past season's pool. Neither is ever started to satisfy a download - an empty kind is skipped by the zip.
    'draft-detail': 'Draft Detail Schema',
    'pro-schedule': 'Pro Schedule Schema',
    odds: 'Scoreboard Odds Schema',
    transactions: 'Transactions Schema',
    'history-pool': 'History Pool Schema'
};
const debugContexts = {
    team: null, 'player-pool': null, 'player-weekly': null, 'player-detail': null,
    'league-history': null, roster: null, 'draft-detail': null, 'pro-schedule': null,
    odds: null, transactions: null, 'history-pool': null
};
// The sport:leagueId:year each kind's payload was captured under, written alongside it in setDebugContext. A Download All run against league B used to pack whatever roster/draft-detail a PRIOR league had left behind, because nothing ever cleared debugContexts on a league switch - My Team's own capture (myteam.js) and the two ensure* hooks (api.js) only ever ASKED "is this kind empty", never "is this kind for the league on screen", so a kind filled once stayed eligible for every zip after, whatever league it was actually fetched under. Two different leagues' answers in one archive is worse than a missing file, since nothing about the zip's own contents says so.
const debugContextLeagueKeys = {
    team: null, 'player-pool': null, 'player-weekly': null, 'player-detail': null,
    'league-history': null, roster: null, 'draft-detail': null, 'pro-schedule': null,
    odds: null, transactions: null, 'history-pool': null
};
// Duplicated rather than imported from api.js's own getLeagueParams for the same reason finalScoringPeriodOf is duplicated in api.js: api.js imports this module, so the reverse import would be a real cycle.
function currentLeagueKey() {
    const sport = document.getElementById('sport')?.value;
    const leagueId = document.getElementById('league-id')?.value;
    const year = document.getElementById('year')?.value;
    return `${sport}:${leagueId}:${year}`;
}
// Whether `kind` holds a payload captured for the league currently on screen. False for a kind that is empty AND for one that is full but stale (captured under a different league) - the two cases the picker, the active panel, and the zip all need to treat the same way: as though nothing were there.
function matchesCurrentLeague(kind) {
    return !!debugContexts[kind] && debugContextLeagueKeys[kind] === currentLeagueKey();
}
// Set while an on-demand diagnostic fetch is in flight for a kind, so the panel shows a loading line for that moment instead of the "nothing captured" placeholder (see ensurePlayerDetailDiagnostic in players.js - the drill-down's capture is lazy now).
const debugLoading = { team: false, 'player-pool': false, 'player-weekly': false, 'player-detail': false };
// Set once the user picks a kind by hand. From then on the panel stops following the view.
let debugKindPinned = false;
// A one-off line the panel shows in place of its usual "nothing captured here" - set when an action has something to say about the panel as a WHOLE rather than about one kind. It has to live here rather than be written straight into the element: the panel re-renders on its own (a tally refresh, a response landing), and a message written directly was overwritten about a second later, which is worse than never showing it. Cleared by anything that changes what the panel is showing, so it never outlives the action that set it.
let debugNotice = null;
let activeDebugKind = 'team';
// The payload actually on screen right now (not the "Label:\n"-prefixed display text) so the download button can save clean, directly-parseable JSON - a full season's worth of per-game stat lines is too big to reliably round-trip through a clipboard paste.
let lastDebugPayload = null;

// Called wherever a fetch useful for diagnostics completes (fetchEspnData in api.js; the player-pool fetch, the leaderboard's bulk weekly fetch, and a single player's weekly fetch in players.js). Storing a payload is cheap (no serialization) - the actual JSON.stringify only happens in renderActiveDebugContext, and only if this kind is the one currently active.
export function setDebugContext(kind, payload) {
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

// Whether a kind already has a captured payload FOR THE LEAGUE ON SCREEN. Lets the lazy drill-down capture (and the two ensure* hooks in api.js) decide if it needs to fetch at all without reaching into this module's internals - and, since a league switch leaves the old payload sitting here until something overwrites it, this is also what makes ensureRosterCapture and ensureDraftDetailCapture re-fetch after a switch instead of trusting the prior league's answer.
export function hasDebugContext(kind) {
    return matchesCurrentLeague(kind);
}

// Marks a kind as "fetching its diagnostic right now". setDebugContext clears it implicitly when the payload lands; callers only need this for the failure path.
export function setDebugLoading(kind, isLoading) {
    debugLoading[kind] = isLoading;
    if (kind === activeDebugKind) renderActiveDebugContext();
}

// Called on every view transition (tab switch, drill-down open/close) so the panel always matches what's on screen even when nothing new was fetched - e.g. backing out of a drill-down re-shows the pool context that's already cached, no re-fetch needed.
export function setActiveDebugKind(kind) {
    debugNotice = null;
    // A hand-picked kind holds. Following the view is the right DEFAULT, but it made one capture effectively unreachable. The weekly chunk was only ever shown on the Player tab before the pool landed, and the moment the pool arrived it won, so taking a copy of a bulk weekly response meant catching a race. Picking is an explicit instruction and outranks the view.
    if (debugKindPinned) return;
    // The Player tab asks for the pool. Before the pool lands, the weekly chunk is the only player response there is, so the panel shows THAT, under its own name rather than the pool's - which is the whole point of splitting the two. Once the pool arrives it wins, since that is what the tab was asking for.
    activeDebugKind = (kind === 'player-pool' && !debugContexts['player-pool'] && debugContexts['player-weekly'])
        ? 'player-weekly'
        : kind;
    renderActiveDebugContext();
}

// Choose which captured response the panel shows and Download takes. Pinned from here on, so the choice survives the tab switches that would otherwise re-sync the panel to the view.
export function pinDebugKind(kind) {
    if (!(kind in debugContexts)) return;
    debugKindPinned = true;
    activeDebugKind = kind;
    renderActiveDebugContext();
}

// O40/S43: player-weekly's own label carries the player count it currently holds, since S43 lifted the old first-chunk-only latch and this kind now accumulates every chunk of a run - a reader watching the panel while a Download All's queue runs sees the count climb chunk by chunk, which is the whole point of no longer freezing it at the first chunk's size. Every other kind keeps its plain, static label; only this one's payload shape is a growing list worth counting.
function labelFor(kind) {
    const base = DEBUG_LABELS[kind] || 'Schema';
    if (kind === 'player-weekly' && matchesCurrentLeague(kind)) {
        const n = (debugContexts[kind].players || []).length;
        return `${base} (${n} player${n === 1 ? '' : 's'})`;
    }
    return base;
}

// One button per kind, disabled while that kind holds nothing. Rebuilt on every render because which responses exist changes as they land, and a button that cannot show anything should say so rather than open an empty panel.
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

// Re-renders the currently active context - called after every context/kind change, and again when the panel's <details> is toggled open (see main.js) so a kind that changed while collapsed still catches up once expanded, instead of showing whatever was on screen when it was last open.
export function refreshDebugPanel() {
    renderActiveDebugContext();
    // Independent of a payload landing: the panel can be opened long after the last fetch, and the tally is still worth redrawing then. renderActiveDebugContext returns early when no payload exists for the active kind, so this cannot ride on it alone.
    if (diagnosticPanelEnabled) renderRequestTally();
}

// The tally, as two honestly separated groups. They are NOT summed into one headline number, because they are not the same thing: an API call carries the league cookie and returns league data, an image load carries a public athlete or team id and returns a picture. A combined total would read as "requests carrying your league data" and be wrong about most of them.
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

// OFF by default. "Off" has to mean the panel is not on the page at all - not a collapsed bar sitting at the foot - because that bar still takes a row of the viewport, and on a tab that is already fighting for vertical room, giving it back is the point of the setting. Every path that would show the panel goes through renderActiveDebugContext, so one check there is the whole gate; nothing else needs to know the preference exists.
let diagnosticPanelEnabled = false;

export function setDiagnosticPanelEnabled(on) {
    diagnosticPanelEnabled = !!on;
    const debugPanel = document.getElementById('debug-panel');
    if (!debugPanel) return;
    if (!diagnosticPanelEnabled) {
        // Closed as well as hidden, so the container's pinned height is released through the same toggle path that a normal close uses (wirePushPanel above). Hiding an OPEN panel would otherwise leave the page pinned tall around a panel nobody can see.
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
    // A stale kind (captured for a league that is no longer on screen) reads as empty here too - the same placeholder a kind that was never fetched shows, never the old league's data under the new league's label.
    const payload = matchesCurrentLeague(activeDebugKind) ? debugContexts[activeDebugKind] : null;
    const label = labelFor(activeDebugKind);
    if (!payload) {
        // Nothing fetched for this context yet - e.g. a drill-down opened for a player whose weekly data the leaderboard's own bulk fetch already cached, so no per-player fetch ran to populate one. Show an explicit placeholder under the RIGHT label instead of leaving a stale, differently-labeled payload from whatever kind was active before - that mismatch (right label, wrong data, or vice versa) is worse than showing nothing. Cheap (no stringify), so no need to gate this on the panel being open.
        if (debugPanel.style.display === 'block') {
            output.textContent = debugNotice
                || (debugLoading[activeDebugKind]
                    ? `${label}: loading...`
                    : `${label}: no diagnostic payload captured for this view yet.`);
        }
        return;
    }
    debugPanel.style.display = 'block';
    // Keep the full raw payload in the downloadable copy even though the preview below only shows one entry - status/settings/schedule (team schema) and a traded/waiver-claimed player's extra entries (player schema) both live outside what the preview slices out.
    lastDebugPayload = payload;
    if (!debugPanel.open) return; // lazy: don't stringify a large payload while collapsed
    const preview = activeDebugKind === 'team'
        ? (payload.teams?.[0] || {})
        : ((payload.players || [])[0] || payload);
    output.textContent = `${label} (preview only, download for the full response):\n` + JSON.stringify(preview, null, 2);
}

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

// Every captured response at once, as one.zip. Reporting a problem used to mean taking each kind in turn, remembering which ones had landed, and hoping the set arrived together - and the kinds that answer a question are rarely the one on screen when it is asked. Each entry is named for its kind, so the archive is self-describing on extraction: a folder of team.json, player-pool.json, roster.json is readable without this panel to explain it. The clock is read HERE and passed down, because zip.js reads none itself (that is what makes its byte layout testable), and the same instant stamps both the entries and the filename. `ensureLazy` is an optional async hook the caller supplies to fill kinds that are only fetched on demand - today the draft detail, which nothing loads unless a surface asks for it, and which is exactly what a draft-shaped capture needs. It is injected rather than imported because this module cannot reach api.js: api.js imports THIS file, and the cycle would be real. The hook is awaited before anything is collected, and its failure is not fatal: a download that refused to happen because one lazy fetch timed out would be worse than one missing a kind, and the zip already skips whatever is empty.
export async function downloadAllDebugData(ensureLazy) {
    if (typeof ensureLazy === 'function') {
        try { await ensureLazy(); } catch { /* a kind that would not load is absent */ }
    }
    const now = new Date();
    const encoder = new TextEncoder();
    const files = Object.keys(DEBUG_LABELS)
        // Never a stale kind - a zip must never carry two leagues (see matchesCurrentLeague). ensureLazy above has already had its chance to re-fill draft-detail/roster for the league on screen; whatever is still stale here stays out rather than going in wrong.
        .filter(kind => matchesCurrentLeague(kind))
        .map(kind => ({
            name: `${kind}.json`,
            bytes: encoder.encode(JSON.stringify(debugContexts[kind], null, 2))
        }));
    // An archive of nothing is a file that opens empty, which reads as a broken download rather than as "there was nothing to send". Say so in the panel instead, in the same place and the same words the panel already uses when a kind holds nothing.
    if (!files.length) {
        debugNotice = 'No diagnostic payloads captured yet. Nothing to download.';
        renderActiveDebugContext();
        return;
    }
    const blob = new Blob([buildZip(files, now)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `espn-debug-all-${now.getTime()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ==== Scoring period to matchup ====

// PURE. The league's REAL day-to-matchup mapping, read off its own schedule. VALIDATED against live captures of four league types. Every H2H schedule side carries pointsByScoringPeriod, a map keyed by the actual scoringPeriodIds that matchup covered, and the game carries matchupPeriodId. Unioning those per matchup gives the boundaries ESPN itself used, and they are NOT the fixed 7 real days this code assumed for a year. Both real leagues checked have several irregular matchups, in both sports and both H2H flavours: MLB, H2H most categories: matchup 1 = periods 1-12 (opening day lands mid-week) matchup 15 = periods 104-117 (the All-Star break, folded in) NHL, H2H points: matchup 1 = periods 1-6 (season opens mid-week) matchup 18 = periods 119-139 (a 21-day break matchup) matchup 25 = periods 182-192 (the last one runs long) One irregular week shifts every matchup after it. In an MLB capture ESPN reported currentMatchupPeriod 16 at scoringPeriodId 124 while floor(124/7) said 17, which is how a Sunday's home runs ended up filed under a matchup that had not started yet. A season-long roto league returns an EMPTY map, and that is correct rather than a failure. Its schedule is one degenerate game with a teams array, no sides and no per-period scores, because roto has no matchups to have boundaries. The caller keeps its own weekly axis for those. This is a different field from settings.scheduleSettings.matchupPeriods, which an earlier fix correctly rejected. That one is a self-reference for ordinary weeks and lists week-INDEX groups for playoff rounds, never real days. pointsByScoringPeriod is real days. PURE, AND A MATCHED PAIR ON PURPOSE. A scoring period's week, and a week's mid-point period. THEY ARE EXACT INVERSES AND THAT IS THE WHOLE REASON THEY LIVE TOGETHER. They were two separate one-liners in players.js, one of them was re-anchored, the other was not, and nothing connected them well enough for anyone to notice: the "mid-week" proxy went on returning week*7+3, which under the NEW mapping is day 3 of the FOLLOWING week. On the Roto Race's rostered tier that credited every week around a trade to the wrong team, silently, for a month. The stale helper's own comment still cited the mapping it had been written against, which is how a reader could check it and come away satisfied. So the invariant is now expressible, and tests/features.test.js asserts it directly: weekOfPeriod(midPeriodOfWeek(w, first), first) === w for every w and every first Week w spans [first + 7(w-1), first + 7w - 1]. The mid-point is the fourth day of that span, which is the best single-owner proxy available without re-bucketing the weekly cache to per-day granularity - a roster change inside a week still attributes the whole week to whoever held the player mid-week, which is the documented residual and a different thing from the wrong week.
export function weekOfPeriod(scoringPeriodId, firstScoringPeriod = 1) {
    const first = Number(firstScoringPeriod) || 1;
    return Math.max(1, Math.floor((Number(scoringPeriodId) - first) / 7) + 1);
}

export function midPeriodOfWeek(week, firstScoringPeriod = 1) {
    const first = Number(firstScoringPeriod) || 1;
    return first + (Math.max(1, Number(week) || 1) - 1) * 7 + 3;
}

// THE LINE A CATEGORY SURFACE SHOWS WHEN THE SPORT'S IDS ARE NOT VALIDATED YET. One sentence, stating the fact. Not an apology and not a promise: "being validated" would be both, and VOICE bans the second half of that sentence anyway. The sport names itself so the line holds for whichever sport arrives next rather than naming football in four render functions. It is deliberately the SAME line everywhere. A reader who meets it on the leaderboard and again on the heatmap has met one fact twice, not two different problems.
export function unmappedCategoriesNote(sport) {
    return `${SPORT_NAMES[sport] || 'This sport'} categories aren't mapped yet.`;
}

// The league's day-to-matchup map, off its OWN schedule. `settings` is optional and adds nothing to the mapping itself - it carries the two facts scheduledPeriodsOfMatchup needs below, so a caller that only wants to bucket a stat day can keep passing two arguments.
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
    // HOW MANY WEEKS EACH MATCHUP HOLDS, and the league's last day. Both are for the span below and neither touches byPeriod, so every existing reading of this map is unchanged. matchupPeriods is read here for its LENGTHS ONLY - how many week indices a matchup holds, a count. Its VALUES are week indices, not scoring periods, and treating them as days is the measured factor-of-seven trap schedule-insight.js opens with. A count of weeks is a different question from which days those weeks are, and it is one this field answers exactly: matchup 22 of a real 2026 MLB league holds [22, 23], two weeks, matching playoffMatchupPeriodLength 2.
    const weeksByMatchup = new Map();
    const declared = ((settings || {}).scheduleSettings || {}).matchupPeriods || {};
    Object.keys(declared).forEach(key => {
        const matchup = Number(key);
        const weeks = Array.isArray(declared[key]) ? declared[key].length : 0;
        if (Number.isFinite(matchup) && matchup > 0 && weeks > 0) weeksByMatchup.set(matchup, weeks);
    });
    const finalPeriod = Number((status || {}).finalScoringPeriod) || 0;
    const map = { byPeriod, lastPeriod, lastMatchup, currentMatchup, weeksByMatchup, finalPeriod };
    // THE OPEN MATCHUP'S REAL SPAN, COMPUTED ONCE AND CARRIED. Two modules decide how long the matchup being played is, and until now they disagreed: this file derived it from the league's own week counts (O54) while probables.js derived its own end from the MODAL length of completed matchups. On a league whose playoff round runs two weeks and whose twenty-two completed rounds ran one, the second answer is a week short - measured, it ended the window on day 166 of a round running to 173 and reported a pitcher's Monday start as not happening. probables.js imports nothing, deliberately, so the answer travels ON the map rather than through a shared import.
    map.currentSpan = spanOfOpenMatchup(map);
    return map;
}

// PURE. The first and last day of the matchup being PLAYED, or null when the league does not support the question (roto, an unscored schedule, a payload with no settings). Split out of scheduledPeriodsOfMatchup so the map can carry the answer and no second module has to re-derive it - the derivation and its measured limits are documented on that function.
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

// PURE. The scoring periods one matchup covers - the days it has SCORED, and for the matchup being played right now the days it has not reached yet. THE DEFECT THIS EXISTS FOR. byPeriod is built from pointsByScoringPeriod, and a matchup in progress has scored only the days already played, so its day list ends on TODAY. Every surface asking "how many games are left in this matchup" was slicing the club schedule with a window that stopped at today, and could only ever answer "one" - MEASURED on a real, live 2026 MLB league, matchup 22 returned days 160-164 while the round really runs 160-173, and every player read "1 of 4 left" in a two-week playoff round. The regular season had the same defect at a smaller scale, "2 of 3 left" on a Wednesday; the playoffs only made it loud. THE DERIVATION, from two payload facts rather than a calendar. The league's own finalScoringPeriod is the last day there is, and weeksByMatchup says how the weeks from here to there are shared out. The matchup's end is its share of the days that remain: end = start + round((final - start + 1) * weeks(m) / weeks of every matchup from m on) - 1 It validates against the COMPLETED record, not only the open one: run on that league it returns 159 for matchup 21 (real: 153-159), 173 for the open matchup 22, and 187 for matchup 23 - the last matchup landing exactly on the season's last day, which is the arithmetic checking itself. A 7-day assumption would agree here and would be an assumption; this reads the league. MEASURED LIMIT, and the reason the failure is in this direction. A break week folded into the CURRENT matchup is under-counted: run on that league's matchup 15 as if it were open the rule returns 8 days where the real span was 14, because nothing in the payload announces the All-Star break before it happens. Under-counting is the failure to prefer - it can never claim games that belong to the next round - and the clamp below makes that guarantee absolute rather than likely. ONLY THE MATCHUP BEING PLAYED is extended. A completed matchup's days are all scored and need no help; a FUTURE matchup returns what it always returned, which on a league whose bracket ESPN has not drawn is nothing at all. Widening that one is a separate question with a surface behind it (the Next lens greys itself off exactly this emptiness), not a side effect of this fix.
export function scheduledPeriodsOfMatchup(map, matchupNumber) {
    if (!map || !map.byPeriod || !matchupNumber) return [];
    const scored = [];
    map.byPeriod.forEach((mp, period) => { if (mp === matchupNumber) scored.push(period); });
    scored.sort((a, b) => a - b);
    if (matchupNumber !== map.currentMatchup) return scored;

    // The span itself is spanOfOpenMatchup's, computed once when the map was built and carried on it, so probables.js reads the same days without importing this module.
    const span = map.currentSpan || spanOfOpenMatchup(map);
    if (!span) return scored;
    const { start, end } = span;

    const last = scored.length ? scored[scored.length - 1] : start - 1;
    if (end <= last) return scored;
    const out = scored.slice();
    for (let period = last + 1; period <= end; period++) out.push(period);
    return out;
}

// PURE. The matchup a day belongs to, given that map. A day past the end of the map has been played but not yet scored into the schedule, so it is today or close to it, and today is in the matchup ESPN reports as current. Using that fact is what makes "this matchup" honest both on its first morning (no days scored yet, so the whole matchup reads empty) and two days in (the scored days are mapped, the rest are still current). An earlier version extrapolated 7 days forward from the last SCORED day instead. That happened to work on a morning when the new matchup had no games, and broke as soon as it had one. The rest of that same matchup fell into the next one. Anchoring on the last matchup's start does not work either, since that matchup may be one of the long ones above. Returns null when the map is empty, so the caller can keep its own fallback rather than being handed a confidently wrong number.
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

// Which way a column opens on its FIRST click (owner ruling,, item 0). One rule for every sortable table in the app: the first click shows the BEST value. For most stats best is the highest, so the column opens descending. For a lower-is-better category - ERA, WHIP, GAA - best is the lowest, so it opens ascending. Before the ruling the leaderboard opened every column descending, which meant sorting by ERA led with the worst pitcher in the league, and the League History career table had already been built the other way. Two sortable tables disagreeing is the thing this exists to stop. The inverse set is passed in rather than read here, so the rule is a pure function of its inputs and the same call works for a stat id, a column key, or anything else a table sorts by.
export function openingSortDir(key, inverseIds) {
    return (inverseIds && inverseIds.has(key)) ? 'asc' : 'desc';
}

// The league-switch registry. Every tab registers how to CLEAR itself and how to SHOW itself, and both the tab buttons and the post-fetch path go through here. The bug it exists to end: a fetch that commits while a tab is on screen used to leave the PREVIOUS league sitting there. It was fixed for Team Metrics, then again for My Team, and then League History shipped with the same fault because the fix was a call added by hand each time and the third tab's call was never added. The owner named it a bug CLASS rather than a bug. With a registry the question moves from "did somebody remember this tab" to "did this tab register", which is answered in the tab's own file, next to the code that needs it. A view that throws is logged and the rest still run. One tab failing to clear must not leave the other three showing another league's numbers, which is the exact failure this is here to prevent.
const leagueViews = new Map();
let activeLeagueView = 'team';

// MERGES rather than replaces, because the two halves are registered from different files on purpose: a tab's reset lives beside the state it clears, and its show lives beside the wiring that draws it. Setting the whole entry silently dropped whichever half registered first. The first run of this registry did exactly that - every reset lost to main.js's show - and the History tab kept the previous league's careers open through a switch, which is the bug it was built to end.
export function registerLeagueView(name, handlers) {
    leagueViews.set(name, { ...(leagueViews.get(name) || {}), ...handlers });
}

export function setActiveLeagueView(name) {
    if (leagueViews.has(name)) activeLeagueView = name;
}

export function showLeagueView(name) {
    setActiveLeagueView(name);
    const view = leagueViews.get(name);
    if (view && view.show) view.show();
}

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

// Called once a fetch has committed, so whichever tab is on screen redraws on the new league. The tabs that are NOT showing are already cleared by resetLeagueViews above and redraw on entry. The registry's third verb. CLEAR is for a new league, SHOW is for a tab coming into view, and REVALIDATE is for the same league re-read a few seconds later: drop whatever this tab caches for the SESSION so it fetches again, without clearing anything off the screen. It exists for the same reason the other two do. The pro-team schedule froze because My Team holds it for the life of the page, and the fix could have been an import from data.js into myteam.js - which would have closed a cycle through api.js, and would have been a call somebody has to remember to add for the next tab that caches something. Registered in the tab's own file instead, beside the cache it invalidates.
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

export function renderActiveLeagueView() {
    const view = leagueViews.get(activeLeagueView);
    if (!view || !view.show) return;
    try {
        view.show();
    } catch (err) {
        // THE STACK, not just the error. These catches exist so one tab's failure cannot take the page down with it - but a swallowed exception in a view is never the desired behaviour, and without the stack the report says only that something went wrong somewhere. It cost a real find: the graded card destroying the trends chart's own container surfaced here as "team failed to render TypeError: reading 'style'", which named neither the culprit nor the line, and the visible symptom (a card stuck loading) pointed somewhere else entirely. console.error rather than a debug flag, always: dev-preview's zero-console-errors check is what turns a swallowed exception back into a failed verification.
        console.error(`League switch: ${activeLeagueView} failed to render`, err && err.stack || err);
    }
}

// Every season this league has, from whatever the app knows. The History tab and the year dropdown both need this and had derived it separately, which is how they disagreed: the dropdown already unioned in the real-world year, and History did not. The bug that forced this: loading 2025 in a league that also has 2026 showed a history ending at 2025. The leagueHistory stub omits UNFINISHED seasons (docs/DATA-SOURCES.md section 9), so 2026 was absent from it, and the only other term was the LOADED season - which is 2025 when you are looking at 2025. The tab's history shrank to wherever the dashboard happened to be standing. The real-world year is the term that fixes it, and it is not a guess: a season ESPN does not have fails its own fetch and is absent, which every caller already handles one season at a time. Next year is deliberately NOT added - ESPN 404s on a season that does not exist yet, and the dropdown has carried that same note since it was written.
export function leagueSeasonYears(historyYears, loadedSeasonId, realYear) {
    return [...new Set([...(historyYears || []), loadedSeasonId, realYear])]
        .map(Number)
        .filter(y => Number.isFinite(y) && y > 0)
        .sort((a, b) => a - b);
}

// The scroll-not-shrink ruling (owner, items 1 and 2). A transient panel opens DOWNWARD: the content around it keeps every pixel it had, the panel takes the space it needs, and the scrollbar that appears is the honest consequence. Closing puts it back exactly. This overrules /the premise. That pass read the page scrolling as the bug and made the container flex-shrink to absorb the console, which is why opening the diagnostic quietly resized every box on the tab behind it. The owner has now ruled the opposite: a panel that shrinks the thing you are reading to avoid a scrollbar has solved the wrong problem. Implementation note: the shrink comes from the flex parent, so the fix is to take the element OUT of the flex negotiation while the panel is open, at exactly the height it already had. Pinning a measured pixel height is what makes "nothing resizes" literally true rather than approximately.
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

// Wires one <details> so opening it PUSHES rather than shrinks. Both call sites go through this rather than each rolling its own, which is the point of it being a ruling and not two fixes. The pin happens on the summary's CLICK, not on the details' toggle, and that is the whole trick: toggle fires AFTER the open state is applied, so by then the flex parent has already taken the space out of the neighbour and the height read there is the shrunken one. The first cut measured in toggle and pinned 464px where the reader had been looking at 728. The click runs first, while the old height is still true.
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

// THIS SESSION'S REQUESTS. One tally, in memory, for as long as the page has been open - nothing is stored and nothing survives a reload, which is the whole scope of the question the panel answers: what has this page asked for since you opened it. Counting happens at the FETCH SITE, not in the panel, and that is deliberate: the panel is behind a Display checkbox now (item 9) and may be off for the whole session. The numbers are therefore true from page open regardless, so switching the panel on halfway through shows what really happened rather than what happened since you looked. Two groups, labelled apart because they are not the same act. An API call is this code deciding to ask ESPN for data. An image load is a browser fetching a src off an <img> the page rendered - no cookies of ours, no filter headers, and a different privacy story. Adding them into one number would flatter the first and hide the second.
const requestTally = {
    startedAt: Date.now(),
    api: { total: 0, byHost: {}, byKind: {} },
    images: { total: 0, byHost: {} }
};

// No base URL, deliberately. Every request this counts is absolute, and resolving against the page instead would file anything unreadable under the extension's own host - a name that looks like an answer and is not one. "unknown" is the honest bucket for a URL nobody can attribute.
const hostOf = (url) => {
    try {
        return new URL(String(url)).hostname || 'unknown';
    } catch {
        return 'unknown';
    }
};

export function countApiRequest(url, kind) {
    requestTally.api.total += 1;
    const host = hostOf(url);
    requestTally.api.byHost[host] = (requestTally.api.byHost[host] || 0) + 1;
    const k = kind || 'other';
    requestTally.api.byKind[k] = (requestTally.api.byKind[k] || 0) + 1;
    scheduleTallyRender();
}

// Called from the img wiring when an image reports back, once each. A logo refused by the host allowlist never becomes an <img> at all, so it cannot reach this and is correctly counted nowhere.
export function countImageRequest(url) {
    requestTally.images.total += 1;
    const host = hostOf(url);
    requestTally.images.byHost[host] = (requestTally.images.byHost[host] || 0) + 1;
    scheduleTallyRender();
}

// Both counters land while the panel may already be open - a fetch resolves, an avatar decodes - and a tally frozen at whatever had happened when you opened it would be worse than none. Coalesced through a timeout so a burst of avatars redraws it once rather than once each.
let tallyRenderQueued = false;
function scheduleTallyRender() {
    if (tallyRenderQueued) return;
    tallyRenderQueued = true;
    setTimeout(() => {
        tallyRenderQueued = false;
        if (diagnosticPanelEnabled && document.getElementById('debug-panel')?.open) renderRequestTally();
    }, 0);
}

export function getRequestTally() {
    return requestTally;
}

// SWID comparison tolerant of the brace-wrapped and case forms ESPN uses in different places, the same rule recap.js matches on.
function sameSwid(a, b) {
    const norm = (s) => String(s || '').replace(/[{}]/g, '').toUpperCase();
    return !!a && !!b && norm(a) === norm(b);
}

// VALIDATED against real captures. teams[].owners is an ARRAY of SWID strings in the brace-wrapped uppercase form the cookie also carries, and teams[].primaryOwner repeats the first of them. members[].id uses the same form. Matching the cookie against owners identifies the user's team; a league the user only spectates matches nothing, which is the switcher-only case My Team is built to handle. It lives HERE rather than in myteam.js, where it was written, because three faces now ask the same question - My Team, the draft room and the pre-draft face - and myteam.js imports graphs.js, so graphs.js reaching back for it would have been a real import cycle for one pure helper.
export function findOwnedTeamId(teams, swid) {
    if (!swid) return null;
    const owned = (teams || []).find(t =>
        (t.owners || []).some(o => sameSwid(o, swid)) || sameSwid(t.primaryOwner, swid));
    return owned ? owned.id : null;
}

// THE ONE RESOLVER FOR "MY TEAM" (S14b). My Team used to carry this exact fallback inline (viewedTeamId/viewedTeamIsStandIn), and the leaderboard's Empty Nights lens (S14) grew a SECOND, stricter one that only ever tried findOwnedTeamId - so the same session could show "YOUR TEAM" on My Team (the stand-in resolving on load) while the lens greyed with "no lineup", the exact two-resolvers-for-one-fact shape the myteam.js group-label bug already named once. One function now answers the question everywhere it is asked. A real SWID match wins outright. Failing that, a STAND-IN - whoever standings puts first - so a cold session (or a league the signed-in user has no team in) has SOME team to resolve rather than none, the exact shape My Team's own tab needs to never sit on a blank screen. `isStandIn` is returned so a caller that must tell the two apart (My Team's "Your team" badge, which never wears itself on a stand-in) can, while a caller asking a different question (Empty Nights: "does a lineup exist to compare against", not "is this definitely mine") can use the id either way.
export function resolveMyTeamId(teams, swid, teamStats) {
    const owned = findOwnedTeamId(teams, swid);
    if (owned != null) return { id: owned, isStandIn: false };
    const standInId = (teamStats && teamStats.length) ? teamStats[0].id : null;
    return { id: standInId, isStandIn: standInId != null };
}
