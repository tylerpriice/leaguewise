import { AppState } from './state.js';

// ESPN occasionally reports a stat value as {value: X} instead of a raw number (seen in both the team-level valuesByStat payload and player stat lines). Most often for players/seasons with no actual games played yet (e.g, drilling into a future/preseason year).
export function statValue(v) {
    return (v && typeof v === 'object') ? v.value : v;
}

export function unwrapStats(rawStats) {
    const result = {};
    Object.keys(rawStats || {}).forEach(id => { result[id] = statValue(rawStats[id]); });
    return result;
}

// Returns the first argument that isn't undefined. For the handful of ESPN payload shapes that use different field names for "the real value" depending on context (boxscore stats prefer appliedTotal over value, cumulativeScore stats prefer score over value).
export function firstDefined(...values) {
    return values.find(v => v !== undefined);
}

// Splits a list of stat ids into "scored" (this league's settings actually use them) and "advanced" (everything else ESPN happens to track), shared between the Team Metrics category filter and every Player Metrics view so the same league config drives what's visible everywhere. forceScored lets a caller pin specific ids (e.g.
export function splitScoredAdvanced(ids, forceScored = new Set()) {
    if (AppState.scoredStatIds.size === 0) return { scored: ids, advanced: [] };

    const scored = ids.filter(id => AppState.scoredStatIds.has(id.toString()) || forceScored.has(id));
    // None of this group's ids match scoredStatIds at all. The league's scoringItems ids aren't lining up with our stat map (or there was nothing to match against).
    if (scored.length === 0) return { scored: ids, advanced: [] };

    const scoredSet = new Set(scored);
    return { scored, advanced: ids.filter(id => !scoredSet.has(id)) };
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

// Resolves the one shared AppState.timeframe value (see rebuildTimeframeOptions in controls.js, the only place that ever produces a value here) into a [start, end] week range. Used by Team Metrics graphs, the Player Metrics leaderboard, and the player drill-down chart alike.
export function getTimeframeBounds(tfVal, maxWk, regWks) {
    if (tfVal === 'all') return { start: 1, end: maxWk };
    if (tfVal === 'reg') return { start: 1, end: Math.min(maxWk, regWks) };
    if (tfVal === 'p_all') return { start: regWks + 1, end: maxWk };

    // Fixed "last N weeks" lookback. Unlike a percentage-of-season lookback, this doesn't need to know the total season length, which turned out to be unreliable for leagues whose own matchup schedule doesn't span the real season.
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
    // Rate-style stats (a weekly AVG, ERA, etc.) are usually well under 4, but the formula above floors every val < 4 up to a fixed max of 4 regardless of how much smaller the real max is. Squashing a chart whose highest point is, say, 1.000 into a quarter of the available height.
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

// Background tint for a stat percentile (0-100). White at 50 (average), fading toward a pastel green above average and a pastel red below, capped short of full saturation so dark text stays legible at every point on the scale.
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

// Every played week is tagged with a bracket tier when the schedule is processed (see data.js). 'reg', 'playoff' (real championship bracket), or 'consolation'.
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

export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

// Wires up a floating tooltip for every [data-tooltip] element inside container.
export function attachDataTooltips(container) {
    if (!container) return;
    const tooltipEl = ensureFloatingTooltip();

    container.querySelectorAll('[data-tooltip]').forEach(el => {
        el.addEventListener('mousemove', (e) => {
            e.stopPropagation();
            tooltipEl.innerHTML = `<strong>${el.getAttribute('data-tooltip')}</strong>`;
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

// The Diagnostic Data panel shows exactly ONE of three contexts at a time. Team schema (Team Metrics tab), the player pool (Player Metrics leaderboard, not drilled into a player), or one player's own detail (an open drill-down). Matching whatever the user is actually looking at.
const DEBUG_LABELS = {
    team: 'Team Schema',
    'player-pool': 'Player Pool Schema',
    'player-detail': 'Player Detail Schema'
};
const debugContexts = { team: null, 'player-pool': null, 'player-detail': null };
let activeDebugKind = 'team';
// The payload actually on screen right now (not the "Label:\n"-prefixed display text) so the download button can save clean, directly-parseable JSON. A full season's worth of per-game stat lines is too big to reliably round-trip through a clipboard paste.
let lastDebugPayload = null;

// Called wherever a fetch useful for diagnostics completes (fetchEspnData in api.js, the player-pool fetch, the leaderboard's bulk weekly fetch, and a single player's weekly fetch in players.js).
export function setDebugContext(kind, payload) {
    debugContexts[kind] = payload;
    if (kind === activeDebugKind) renderActiveDebugContext();
}

// Called on every view transition (tab switch, drill-down open/close) so the panel always matches what's on screen even when nothing new was fetched. e.g. backing out of a drill-down re-shows the pool context that's already cached, no re-fetch needed.
export function setActiveDebugKind(kind) {
    activeDebugKind = kind;
    renderActiveDebugContext();
}

// Re-renders the currently active context. Called after every context/kind change, and again when the panel's <details> is toggled open (see main.js) so a kind that changed while collapsed still catches up once expanded, instead of showing whatever was on screen when it was last open.
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
        // Nothing fetched for this context yet. e.g. a drill-down opened for a player whose weekly data the leaderboard's own bulk fetch already cached, so no per-player fetch ran to populate one.
        if (debugPanel.style.display === 'block') output.textContent = `${label}: no diagnostic payload captured for this view yet.`;
        return;
    }
    debugPanel.style.display = 'block';
    // Keep the full raw payload in the downloadable copy even though the preview below only shows one entry. status/settings/schedule (team schema) and a traded/waiver-claimed player's extra entries (player schema) both live outside what the preview slices out.
    lastDebugPayload = payload;
    if (!debugPanel.open) return; // lazy: don't stringify a large payload while collapsed
    const preview = activeDebugKind === 'team'
        ? (payload.teams?.[0] || {})
        : ((payload.players || [])[0] || payload);
    output.textContent = `${label} (preview only - download for full response):\n` + JSON.stringify(preview, null, 2);
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