import { AppState, PITCHING_IDS, GOALIE_IDS, ESPN_STAT_MAPS, ESPN_STAT_FULL_NAMES } from './state.js';

// Role-grouped ordering for any list of stat ids: batting before pitching, skaters before goalies. A stable partition, so the caller's own order survives inside each group, which matters because Object.keys returns integer-like keys in ascending numeric order and interleaves the roles.
const ROLE_ID_SETS = { flb: PITCHING_IDS, fhl: GOALIE_IDS };

export function splitStatIdsByRole(sport, statIds) {
    const secondaryIds = ROLE_ID_SETS[sport];
    const primary = [], secondary = [];
    statIds.forEach(id => {
        // Callers hand ids over as strings or as numbers, while the role sets are string-keyed.
        if (secondaryIds && secondaryIds.has(String(id))) secondary.push(id);
        else primary.push(id);
    });
    return { primary, secondary };
}

export function orderStatIdsByRole(sport, statIds) {
    const { primary, secondary } = splitStatIdsByRole(sport, statIds);
    return [...primary, ...secondary];
}

// ESPN sometimes reports a stat as { value: X } rather than a raw number, most often when no games have been played yet. The truthiness check is deliberate, since typeof null is also 'object' and ESPN does send null.
export function statValue(v) {
    return (v && typeof v === 'object') ? v.value : v;
}

// JSON cannot write an infinite number, so ESPN sends the STRING "Infinity" for a rate whose denominator is still zero. That is a real value rather than corrupt data: a team with earned runs and no innings genuinely has an infinite ERA, which is why it turns up on a live matchup. VALIDATED in a real league mid-matchup, where stat 47 arrived as "Infinity". Every category value passes through here, so nothing downstream has to think about it. Anything that is not a number becomes null, since null already means no value everywhere in this app while NaN poisons arithmetic quietly.
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

// Returns the first argument that is not undefined, for the payload shapes that name the real value differently depending on context.
export function firstDefined(...values) {
    return values.find(v => v !== undefined);
}

// Splits stat ids into this league's scored set and everything else ESPN tracks, so one league config drives what is visible on both tabs. forceScored pins specific ids into the visible set.
export function splitScoredAdvanced(ids, forceScored = new Set()) {
    if (AppState.scoredStatIds.size === 0) return { scored: ids, advanced: [] };

    const scored = ids.filter(id => AppState.scoredStatIds.has(id.toString()) || forceScored.has(id));
    // None of this group's ids match scoredStatIds, so show everything rather than presenting what looks like an empty list.
    if (scored.length === 0) return { scored: ids, advanced: [] };

    const scoredSet = new Set(scored);
    return { scored, advanced: ids.filter(id => !scoredSet.has(id)) };
}

// The ordered list of categories the Category Rankings pager cycles, plus the count it is leaving out. Role-grouped, and deduplicated by name because ESPN's stat map carries aliases that would otherwise read as two identical categories.
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

// One x-axis vocabulary per league type, so a screen can never mix tokens. H2H graphs index matchups and a playoff matchup can span two or three real weeks, roto has no matchup periods and reads in weeks, and the race cards plot real scoring days and keep their own Day N.
export function axisUnit() {
    return AppState.isRotoLeague
        ? { short: 'WK', long: 'Week', plural: 'Weeks' }
        : { short: 'M', long: 'Matchup', plural: 'Matchups' };
}

// A category header label puts the abbreviation first, since that is what every other surface shows, with the spelled-out name after it. Falls back to the abbreviation alone when there is no documented expansion.
export function categoryHeaderLabel(sport, statId, shortName) {
    const full = (ESPN_STAT_FULL_NAMES[sport] || {})[statId];
    return (!full || full === shortName) ? shortName : `${shortName} (${full})`;
}

// How many categories the Advanced Stats toggle would add. Zero means the league scores everything ESPN tracks for it, so the toggle hides itself.
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

// PURE. A timeframe value is two independent choices, not one: which part of the season, and how recent a stretch within it. They are stored as "span" or "span+lastN" so the two segmented controls in the tab bar each own one of them. A bare "lastN" still parses, so a timeframe stored by an older session restores as a full-season lookback rather than being dropped.
export function parseTimeframe(tfVal) {
    const parts = String(tfVal || 'all').split('+');
    const head = parts[0];
    if (head.startsWith('last')) return { span: 'all', window: parseInt(head.slice(4), 10) || null };
    const tail = parts[1];
    const window = tail && tail.startsWith('last') ? (parseInt(tail.slice(4), 10) || null) : null;
    return { span: head, window };
}

// Resolves the one shared timeframe value into a [start, end] week range, used by the Team Metrics graphs, the leaderboard and the drill-down chart alike. The span resolves first and the window is then clamped inside it, so a window wider than its span collapses to the span rather than reaching past it.
export function getTimeframeBounds(tfVal, maxWk, regWks, currentWk = 0) {
    const { span, window: n } = parseTimeframe(tfVal);

    let start = 1;
    let end = maxWk;
    if (span === 'reg') end = Math.min(maxWk, regWks);
    else if (span === 'p_all') start = regWks + 1;

    if (n) {
        // currentWk is the matchup being played right now. It moves only the "Current" pill, and only on the morning before that matchup's first game, when nothing is scored and maxWk still points at the matchup that just ended. Every other window is retrospective and ends at the last completed matchup. It is accepted only one past maxWk, and only for a span that contains it, so the regular season's last four do not move because a playoff matchup started.
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
    // Rate stats sit well under 4, so flooring every max up to 4 squashes a chart whose highest point is 1.000 into a quarter of its height. Scale the quarter-step rounding by powers of 10 instead.
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

// Background tint for a percentile: white at 50, fading to pastel green above and pastel red below, capped short of full saturation so dark text stays legible.
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

// Every played week carries a bracket tier when the schedule is processed: 'reg', 'playoff' or 'consolation'.
export function getWeekTier(team, week) {
    return team.weeklyTier?.[week] || 'reg';
}

export function tierColor(tier, baseColor) {
    if (tier === 'playoff') return shadeColor(baseColor, -25);
    if (tier === 'consolation') return shadeColor(baseColor, 45);
    return baseColor;
}

// Splits a weekly series into regular season and each playoff tier, so a bar can show the breakdown as one gradient fill.
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

// ESPN's injuryStatus, mapped to what a person would call it. Every token was counted in real captures rather than taken from a reference: across eight payloads covering both sports and three seasons, baseball reports ACTIVE, DAY_TO_DAY and the four DL lengths, while hockey reports ACTIVE, OUT, INJURY_RESERVE and SUSPENSION. MLB renamed the disabled list to the injured list in 2019 and ESPN kept the old key, so the label reads IL where the key still says DL.
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

// Anything ESPN sends that is not in the table above still gets a badge, labelled with ESPN's own word rather than a guess at what it means. Titlecasing the token is the honest fallback: a status we have never seen is a reason to show something, not to stay silent about an unavailable player.
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

// Escapes the five HTML-significant characters, single quotes included so a value is safe in a single-quoted attribute. Read sites that pull an escaped value back out of an attribute must use textContent, or they re-decode and re-arm the markup.
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

// Lays out and positions a chart hover tooltip against the VIEWPORT, so a deep league's readout is not clamped inside a short chart box. When even the viewport cannot fit one column the rows reflow column-major, which keeps the best-first sort reading as a mini-standings, and the list is never truncated.
export function layoutHoverTooltip(tooltipEl, clientX, clientY) {
    const rowsEl = tooltipEl.querySelector('.tt-rows');
    // Start every measurement from the natural single column, since a previous mousemove may have left a grid reflow on the shared element.
    if (rowsEl) {
        rowsEl.style.display = '';
        rowsEl.style.gridAutoFlow = '';
        rowsEl.style.gridTemplateRows = '';
        rowsEl.style.columnGap = '';
    }

    const margin = 12;
    const availH = window.innerHeight - margin * 2;

    if (rowsEl && rowsEl.children.length > 1) {
        // Average the stacked column's height across its rows so the per-row figure includes each row's margin, or the columns pack too tightly and the tooltip still overflows.
        const rowH = (rowsEl.scrollHeight / rowsEl.children.length) || 18;
        const headerH = tooltipEl.querySelector('.tt-header')?.offsetHeight || 0;
        // Height the rows may fill: the viewport minus the header, the tooltip's own padding, and a small safety gap. Column-major, so rows per column is the lever.
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

// The explanatory hint tooltips on panel headings. They were once a second implementation, absolutely positioned inside the header and centred on the trigger, which is what made a 250px box hang past a trigger near the right edge. It still counted in the page's scrollable width while hidden, so the page scrolled sideways because of something nobody could see, and the scrollbar that raised ate 15px of height and brought vertical scroll back with it. Fixed positioning is the real fix, since a fixed element is out of flow and cannot extend the page at any width, and clamping to the viewport comes with it. Text, never markup: the hint is written as an attribute and read back with textContent, so a heading cannot smuggle HTML into the page.
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

// Wires a floating tooltip for every [data-tooltip] element inside container. Stopping propagation means a segment's tooltip wins over an ancestor's rather than both firing.
export function attachDataTooltips(container) {
    if (!container) return;
    const tooltipEl = ensureFloatingTooltip();

    container.querySelectorAll('[data-tooltip]').forEach(el => {
        el.addEventListener('mousemove', (e) => {
            e.stopPropagation();
            // Text-only on purpose: getAttribute DECODES the entities the write sites escaped, so piping it back through innerHTML re-arms hostile markup in a team name.
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

// The diagnostic panel shows exactly one of three contexts at a time (team schema, player pool, one player's detail). Each kind's payload is tracked independently, so a background prefetch cannot clobber the context on screen.
const DEBUG_LABELS = {
    team: 'Team Schema',
    'player-pool': 'Player Pool Schema',
    'player-weekly': 'Weekly Stats Chunk',
    'player-detail': 'Player Detail Schema'
};
const debugContexts = { team: null, 'player-pool': null, 'player-weekly': null, 'player-detail': null };
// Set while an on-demand diagnostic fetch is in flight, so the panel shows a loading line instead of the nothing-captured placeholder.
const debugLoading = { team: false, 'player-pool': false, 'player-weekly': false, 'player-detail': false };
let activeDebugKind = 'team';
// The payload on screen right now, without the label prefix, so the download button saves directly parseable JSON.
let lastDebugPayload = null;

// Storing a payload is cheap: the stringify happens only when this kind is the active one.
export function setDebugContext(kind, payload) {
    debugContexts[kind] = payload;
    debugLoading[kind] = false;
    // A pool landing while the panel shows the weekly stand-in promotes itself, so the view never sits on the substitute once the real thing is available.
    if (kind === 'player-pool' && activeDebugKind === 'player-weekly') activeDebugKind = 'player-pool';
    if (kind === activeDebugKind) renderActiveDebugContext();
}

// Whether a kind already has a captured payload, so the lazy drill-down capture can decide whether it needs to fetch at all.
export function hasDebugContext(kind) {
    return !!debugContexts[kind];
}

// Marks a kind as fetching its diagnostic. setDebugContext clears it when the payload lands, so callers only need this for the failure path.
export function setDebugLoading(kind, isLoading) {
    debugLoading[kind] = isLoading;
    if (kind === activeDebugKind) renderActiveDebugContext();
}

// Called on every view transition, so the panel matches the screen even when nothing new was fetched.
export function setActiveDebugKind(kind) {
    // A weekly chunk is not the pool. Promote to it only when the pool itself has nothing captured, so the panel never labels one as the other.
    activeDebugKind = (kind === 'player-pool' && !debugContexts['player-pool'] && debugContexts['player-weekly'])
        ? 'player-weekly'
        : kind;
    renderActiveDebugContext();
}

// Re-renders the active context, including when the panel is expanded, so a kind that changed while collapsed catches up.
export function refreshDebugPanel() {
    renderActiveDebugContext();
}

function renderActiveDebugContext() {
    const debugPanel = document.getElementById('debug-panel');
    const output = document.getElementById('debug-output');
    if (!debugPanel || !output) return;
    const payload = debugContexts[activeDebugKind];
    const label = DEBUG_LABELS[activeDebugKind] || 'Schema';
    if (!payload) {
        // Nothing has been fetched for this context yet, so show an explicit placeholder under the right label rather than a stale payload from whichever kind was active before.
        if (debugPanel.style.display === 'block') {
            output.textContent = debugLoading[activeDebugKind]
                ? `${label}: loading...`
                : `${label}: no diagnostic payload captured for this view yet.`;
        }
        return;
    }
    debugPanel.style.display = 'block';
    // The downloadable copy keeps the full raw payload, since the preview below slices out only one entry.
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

// PURE. The league's real day-to-matchup mapping, read off its own schedule. Every H2H schedule side carries pointsByScoringPeriod, keyed by the scoringPeriodIds that matchup covered, and the game carries matchupPeriodId. Validated against live captures of four league types, where matchups are NOT the fixed seven days this once assumed: an opening week can run long, a break week can fold two or three weeks into one matchup, and one irregular week shifts every matchup after it. A season-long roto league returns an empty map, which is correct rather than a failure, because roto has no matchups to have boundaries. This is a different field from settings.scheduleSettings.matchupPeriods, which is a self-reference for ordinary weeks and lists week-index groups for playoff rounds, never real days.
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
                // The lowest matchup wins a contested day, which belongs to the earlier one that was live.
                const prev = byPeriod.get(period);
                if (prev === undefined || mp < prev) byPeriod.set(period, mp);
                if (period > lastPeriod) lastPeriod = period;
                contributed = true;
            });
        });
        if (contributed && mp > lastMatchup) lastMatchup = mp;
    });
    // The matchup being played right now, straight from the payload, which is what resolves days the schedule has not scored yet.
    const currentMatchup = (status || {}).currentMatchupPeriod || 0;
    return { byPeriod, lastPeriod, lastMatchup, currentMatchup };
}

// PURE. The matchup a day belongs to, given that map. A day past the end of the map has been played but not yet scored into the schedule, so it is today or close to it, and today is in the matchup ESPN reports as current. Returns null when the map is empty, so the caller keeps its own fallback rather than being handed a confidently wrong number.
export function matchupOfPeriod(map, scoringPeriodId) {
    if (!map || !map.byPeriod.size) return null;
    const known = map.byPeriod.get(scoringPeriodId);
    if (known !== undefined) return known;
    if (scoringPeriodId > map.lastPeriod) {
        if (map.currentMatchup >= map.lastMatchup) return map.currentMatchup;
        // No usable status: the ordinary seven-day cadence from the first unscored day is the last resort.
        return map.lastMatchup + 1 + Math.floor((scoringPeriodId - map.lastPeriod - 1) / 7);
    }
    // A gap below the last mapped day is an off day the schedule skipped, not a new matchup, so it takes the nearest matchup already established before it.
    let best = null;
    map.byPeriod.forEach((mp, period) => {
        if (period < scoringPeriodId && (best === null || period > best.period)) best = { period, mp };
    });
    return best ? best.mp : null;
}
