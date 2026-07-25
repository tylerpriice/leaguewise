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

// Resolves the one shared timeframe value into a [start, end] week range, used by the Team Metrics graphs, the leaderboard and the drill-down chart alike.
export function getTimeframeBounds(tfVal, maxWk, regWks) {
    if (tfVal === 'all') return { start: 1, end: maxWk };
    if (tfVal === 'reg') return { start: 1, end: Math.min(maxWk, regWks) };
    if (tfVal === 'p_all') return { start: regWks + 1, end: maxWk };

    // A fixed lookback does not need the total season length, which is unreliable for leagues whose matchup schedule does not span the real season.
    const n = parseInt(tfVal.slice(4), 10);
    return { start: Math.max(1, maxWk - n + 1), end: maxWk };
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
    'player-detail': 'Player Detail Schema'
};
const debugContexts = { team: null, 'player-pool': null, 'player-detail': null };
// Set while an on-demand diagnostic fetch is in flight, so the panel shows a loading line instead of the nothing-captured placeholder.
const debugLoading = { team: false, 'player-pool': false, 'player-detail': false };
let activeDebugKind = 'team';
// The payload on screen right now, without the label prefix, so the download button saves directly parseable JSON.
let lastDebugPayload = null;

// Storing a payload is cheap: the stringify happens only when this kind is the active one.
export function setDebugContext(kind, payload) {
    debugContexts[kind] = payload;
    debugLoading[kind] = false;
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
    activeDebugKind = kind;
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
