import { AppState, PITCHING_IDS, GOALIE_IDS, ESPN_STAT_MAPS, ESPN_STAT_FULL_NAMES } from './state.js';

// Role-grouped ordering for any list of stat ids that can mix roles. Batting comes before pitching (flb), skaters before goalies (fhl). A STABLE partition, so the caller's own relative order survives within each group - a league's scoring-item order (or the stat map's order) still decides everything except which side of the split a category lands on. Driven by the same validated role sets the app already splits its group tabs by, so this adds no stat knowledge. Why it is needed. Displayed order used to be whatever the source happened to produce, and those sources interleave the roles. Object.keys returns integer-like keys in ASCENDING NUMERIC order no matter how the stat map is written, so baseball's fielding ids (67-73, batting-group stats) sort after the whole pitching block, and hockey's goalie ids (0-11) sort BEFORE every skater id - which is why the hockey heatmap led with W/SO/GAA/SV%. A league's scoringItems order (AppState.scoredStatIds, what the recap walks) interleaves them freely too. A single-role league is unaffected by construction. Everything lands in one group, so the output is the input, in the input's order.
const ROLE_ID_SETS = { flb: PITCHING_IDS, fhl: GOALIE_IDS };

export function splitStatIdsByRole(sport, statIds) {
    const secondaryIds = ROLE_ID_SETS[sport];
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

// Background tint for a stat percentile (0-100) - white at 50 (average), fading toward a pastel green above average and a pastel red below, capped short of full saturation so dark text stays legible at every point on the scale.
export function percentileColor(pct) {
    const clamp = Math.max(0, Math.min(100, pct));
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    let r, g, b;
    if (clamp >= 50) {
        const t = (clamp - 50) / 50;
        [r, g, b] = [lerp(255, 184, t), lerp(255, 230, t), lerp(255, 193, t)]; // white -> pastel green
    } else {
        const t = clamp / 50;
        [r, g, b] = [lerp(244, 255, t), lerp(184, 255, t), lerp(189, 255, t)]; // pastel red -> white
    }
    return `rgb(${r}, ${g}, ${b})`;
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

export function ensureFloatingTooltip() {
    let el = document.getElementById('floating-tooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'floating-tooltip';
        el.style.cssText = 'position:fixed; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:8px 12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:nowrap; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
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
    };
    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest?.('[data-hint]');
        if (target) show(target);
    });
    document.addEventListener('mouseout', (e) => {
        if (e.target.closest?.('[data-hint]')) hide();
    });
    document.addEventListener('focusin', (e) => {
        const target = e.target.closest?.('[data-hint]');
        if (target) show(target);
    });
    document.addEventListener('focusout', hide);
    // A scroll or resize moves the anchor out from under a tooltip measured against the old layout.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
}

// Wires up a floating tooltip for every [data-tooltip] element inside container. Used for bar segments (and pie slices) so each hoverable region can show its own text - stopping propagation means a segment's tooltip wins over any ancestor's, rather than both firing.
export function attachDataTooltips(container) {
    if (!container) return;
    const tooltipEl = ensureFloatingTooltip();

    container.querySelectorAll('[data-tooltip]').forEach(el => {
        el.addEventListener('mousemove', (e) => {
            e.stopPropagation();
            // Text-only on purpose. getAttribute DECODES the entities the write sites escaped, so piping it back through innerHTML re-armed hostile markup in team names (the classic escape-then-unescape hole). Building the <strong> as a node and setting textContent keeps the styling with zero HTML parsing of attacker-reachable text.
            tooltipEl.textContent = '';
            const strong = document.createElement('strong');
            strong.textContent = el.getAttribute('data-tooltip');
            tooltipEl.appendChild(strong);
            tooltipEl.style.display = 'block';
            tooltipEl.style.left = (e.clientX + 15) + 'px';
            tooltipEl.style.top = (e.clientY + 15) + 'px';
        });
        el.addEventListener('mouseleave', (e) => {
            e.stopPropagation();
            tooltipEl.style.display = 'none';
        });
    });
}

// The Diagnostic Data panel shows exactly ONE of three contexts at a time - team schema (Team Metrics tab), the player pool (Player Metrics leaderboard, not drilled into a player), or one player's own detail (an open drill-down) - matching whatever the user is actually looking at. Previously every fetch just overwrote a single shared slot last-write-wins, so a background prefetch (the player pool warms up as soon as league data loads - see prefetchPlayerData in players.js) could silently clobber the team schema before the user ever switched tabs, and a background weekly-stats refetch could clobber an open drill-down's own debug mid-view. Each kind's payload is tracked independently; setActiveDebugKind (called on every tab switch and drill-down open/close - see main.js and players.js) decides which one is currently shown. A fourth kind, player-weekly, exists because the leaderboard's bulk weekly fetch used to write its first chunk into the POOL slot. The panel then offered a 75-player weekly chunk under the label "Player Pool Schema", and a download taken to inspect the pool silently produced daily splits for whichever rows happened to be on screen. Two captures taken minutes apart came back byte-identical while claiming to be different things, which is how it was found. Each response now sits under its own name ( field work).
const DEBUG_LABELS = {
    team: 'Team Schema',
    'player-pool': 'Player Pool Schema',
    'player-weekly': 'Weekly Stats Chunk',
    'player-detail': 'Player Detail Schema'
};
const debugContexts = { team: null, 'player-pool': null, 'player-weekly': null, 'player-detail': null };
// Set while an on-demand diagnostic fetch is in flight for a kind, so the panel shows a loading line for that moment instead of the "nothing captured" placeholder (see ensurePlayerDetailDiagnostic in players.js - the drill-down's capture is lazy now).
const debugLoading = { team: false, 'player-pool': false, 'player-weekly': false, 'player-detail': false };
// Set once the user picks a kind by hand. From then on the panel stops following the view.
let debugKindPinned = false;
let activeDebugKind = 'team';
// The payload actually on screen right now (not the "Label:\n"-prefixed display text) so the download button can save clean, directly-parseable JSON - a full season's worth of per-game stat lines is too big to reliably round-trip through a clipboard paste.
let lastDebugPayload = null;

// Called wherever a fetch useful for diagnostics completes (fetchEspnData in api.js; the player-pool fetch, the leaderboard's bulk weekly fetch, and a single player's weekly fetch in players.js). Storing a payload is cheap (no serialization) - the actual JSON.stringify only happens in renderActiveDebugContext, and only if this kind is the one currently active.
export function setDebugContext(kind, payload) {
    debugContexts[kind] = payload;
    // A newly captured kind gets its button enabled straight away, whatever is on screen.
    renderDebugPicker();
    debugLoading[kind] = false;
    // A pool landing while the panel is showing the weekly stand-in promotes itself, so the view never sits on the substitute once the real thing is available.
    if (kind === 'player-pool' && activeDebugKind === 'player-weekly') activeDebugKind = 'player-pool';
    if (kind === activeDebugKind) renderActiveDebugContext();
}

// Whether a kind already has a captured payload. Lets the lazy drill-down capture decide if it needs to fetch at all without reaching into this module's internals.
export function hasDebugContext(kind) {
    return !!debugContexts[kind];
}

// Marks a kind as "fetching its diagnostic right now". setDebugContext clears it implicitly when the payload lands; callers only need this for the failure path.
export function setDebugLoading(kind, isLoading) {
    debugLoading[kind] = isLoading;
    if (kind === activeDebugKind) renderActiveDebugContext();
}

// Called on every view transition (tab switch, drill-down open/close) so the panel always matches what's on screen even when nothing new was fetched - e.g. backing out of a drill-down re-shows the pool context that's already cached, no re-fetch needed.
export function setActiveDebugKind(kind) {
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

// One button per kind, disabled while that kind holds nothing. Rebuilt on every render because which responses exist changes as they land, and a button that cannot show anything should say so rather than open an empty panel.
function renderDebugPicker() {
    const host = document.getElementById('debug-kinds');
    if (!host) return;
    host.innerHTML = Object.keys(DEBUG_LABELS).map(kind => {
        const has = !!debugContexts[kind];
        const on = kind === activeDebugKind;
        return `<button type="button" class="debug-kind${on ? ' active' : ''}" data-kind="${kind}"
                    ${has ? '' : 'disabled'}
                    title="${has ? 'Show this response' : 'Nothing captured for this yet'}">${DEBUG_LABELS[kind]}</button>`;
    }).join('');
}

// Re-renders the currently active context - called after every context/kind change, and again when the panel's <details> is toggled open (see main.js) so a kind that changed while collapsed still catches up once expanded, instead of showing whatever was on screen when it was last open.
export function refreshDebugPanel() {
    renderActiveDebugContext();
}

function renderActiveDebugContext() {
    const debugPanel = document.getElementById('debug-panel');
    const output = document.getElementById('debug-output');
    if (!debugPanel || !output) return;
    renderDebugPicker();
    const payload = debugContexts[activeDebugKind];
    const label = DEBUG_LABELS[activeDebugKind] || 'Schema';
    if (!payload) {
        // Nothing fetched for this context yet - e.g. a drill-down opened for a player whose weekly data the leaderboard's own bulk fetch already cached, so no per-player fetch ran to populate one. Show an explicit placeholder under the RIGHT label instead of leaving a stale, differently-labeled payload from whatever kind was active before - that mismatch (right label, wrong data, or vice versa) is worse than showing nothing. Cheap (no stringify), so no need to gate this on the panel being open.
        if (debugPanel.style.display === 'block') {
            output.textContent = debugLoading[activeDebugKind]
                ? `${label}: loading...`
                : `${label}: no diagnostic payload captured for this view yet.`;
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

// ==== Scoring period to matchup ====

// PURE. The league's REAL day-to-matchup mapping, read off its own schedule. VALIDATED against live captures of four league types. Every H2H schedule side carries pointsByScoringPeriod, a map keyed by the actual scoringPeriodIds that matchup covered, and the game carries matchupPeriodId. Unioning those per matchup gives the boundaries ESPN itself used, and they are NOT the fixed 7 real days this code assumed for a year. Both real leagues checked have several irregular matchups, in both sports and both H2H flavours: MLB, H2H most categories: matchup 1 = periods 1-12 (opening day lands mid-week) matchup 15 = periods 104-117 (the All-Star break, folded in) NHL, H2H points: matchup 1 = periods 1-6 (season opens mid-week) matchup 18 = periods 119-139 (a 21-day break matchup) matchup 25 = periods 182-192 (the last one runs long) One irregular week shifts every matchup after it. In an MLB capture ESPN reported currentMatchupPeriod 16 at scoringPeriodId 124 while floor(124/7) said 17, which is how a Sunday's home runs ended up filed under a matchup that had not started yet. A season-long roto league returns an EMPTY map, and that is correct rather than a failure. Its schedule is one degenerate game with a teams array, no sides and no per-period scores, because roto has no matchups to have boundaries. The caller keeps its own weekly axis for those. This is a different field from settings.scheduleSettings.matchupPeriods, which an earlier fix correctly rejected. That one is a self-reference for ordinary weeks and lists week-INDEX groups for playoff rounds, never real days. pointsByScoringPeriod is real days.
export function buildMatchupPeriodMap(schedule, status) {
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
    return { byPeriod, lastPeriod, lastMatchup, currentMatchup };
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
