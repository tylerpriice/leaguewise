import { AppState, AVERAGE_STATS, INVERSE_STATS, ESPN_STAT_MAPS } from './state.js';
import { getZoomedFillPct, getTimeframeBounds, getNiceMax, getWeekTier, tierColor, splitByTier, escapeHtml, attachDataTooltips, percentileColor } from './utils.js';

const TIER_LABELS = { reg: 'Regular Season', playoff: 'Playoffs', consolation: 'Consolation' };

// Minimum leftover space (px) below the Rankings bars before it's worth showing both pies inline instead of leaving them behind #pie-selector's "Pie Charts" view. See renderLeftColumn's use of this after laying out the bars.
const INLINE_PIE_MIN_HEIGHT = 140;

// Upper bound on how big the inline pies (see renderInlinePies) are allowed to grow even when there's abundant leftover space (e.g, two teams, one week played). Big enough to genuinely use the room, not so big a couple of sparse rows blow the pies up to dominate the whole box.
const INLINE_PIE_MAX_SIZE = 280;

// .bar-fill isn't overflow:hidden, so a value label too wide for a short bar would otherwise spill into the team-name column beside it.
const ASSUMED_TRACK_WIDTH_PX = 480;
function isBarTooSmallForLabel(pct, label) {
    // String(...). Some callers (e.g, renderCategoryGraph's formatVal) pass a raw number through for whole values rather than a pre-formatted string.
    const estimatedLabelWidthPx = String(label).length * 6.5 + 16;
    const barWidthPx = (pct / 100) * ASSUMED_TRACK_WIDTH_PX;
    return barWidthPx < estimatedLabelWidthPx;
}

// Renders a bar's fill as one segment per tier present in `split`, each with its own data-tooltip so hovering a shaded portion shows that portion's own total.
function buildBarSegments(split, baseColor, overallTooltip, formatVal = (v) => v.toFixed(1)) {
    const { reg, playoff, consolation, total } = split;
    const parts = [
        { val: reg, tier: 'reg' },
        { val: playoff, tier: 'playoff' },
        { val: consolation, tier: 'consolation' }
    ].filter(p => p.val > 0);

    if (total <= 0 || parts.length <= 1) {
        const tier = parts[0]?.tier || 'reg';
        return `<div class="bar-segment" style="width:100%; background:${tierColor(tier, baseColor)};" data-tooltip="${escapeHtml(overallTooltip)}"></div>`;
    }

    return parts.map(p => {
        const pct = (p.val / total) * 100;
        const tip = `${formatVal(p.val)} ${TIER_LABELS[p.tier]}`;
        return `<div class="bar-segment" style="width:${pct}%; background:${tierColor(p.tier, baseColor)};" data-tooltip="${escapeHtml(tip)}"></div>`;
    }).join('');
}

// Shared "Section Title" header for a team-block. Used by both the single-week comparison bars and the Category Rankings graph, which otherwise build their block markup independently.
function buildBlockHeaderHtml(title) {
    return `<h4 style="margin: 0 0 10px 0; border-bottom: 2px solid var(--border); padding-bottom: 6px; color: var(--text-body); font-size: 14px;">${title}</h4>`;
}

// Shared "nothing to show" placeholder. Used wherever a graph box has no content to render because of the user's own current filter selection (no metric toggled on, no category checked, every team hidden), rather than a real data problem.
function buildEmptyStateHtml(message) {
    return `<div style="color: var(--text-subtle); text-align: center; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 14px;">${message}</div>`;
}

// One team's row in a bar-comparison block. Shared by renderSingleWeekBars (single-matchup Category Wins/Match Wins) and renderCategoryGraph (Category Rankings), which differ only in how they compute val/split/formatVal for their rows, not in how a row itself is built.
function buildComparisonBarRowHtml({ name, val, color, minVal, maxVal, leaderVal, isLeader, split, formatVal = (v) => v.toFixed(1) }) {
    const fillPct = getZoomedFillPct(val, minVal, maxVal);
    const displayVal = formatVal(val);
    const overallTooltip = isLeader
        ? `${displayVal}: Leader`
        : `${displayVal}: ${formatVal(Math.abs(leaderVal - val))} back`;
    const segments = buildBarSegments(split, color, overallTooltip, formatVal);
    // No new tooltip needed here for a small bar. Segments already carry one covering the bar's full width (overallTooltip, built above, already includes displayVal).
    const labelHidden = isBarTooSmallForLabel(fillPct, displayVal);

    return `
        <div class="bar-row">
            <span class="bar-title" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div class="bar-track">
                <div class="bar-fill" style="width:${fillPct}%;">
                    ${segments}
                    ${labelHidden ? '' : `<span class="bar-value-label">${displayVal}</span>`}
                </div>
            </div>
        </div>
    `;
}

// W-L-T match record, broken down by tier, for the H2H Match Wins bar. A "record" is clearer there than a raw decimal sum of 1/0.5/0 weekly results.
function computeRecordByTier(team, startWeek, endWeek) {
    const rec = { reg: { w: 0, t: 0, l: 0 }, playoff: { w: 0, t: 0, l: 0 }, consolation: { w: 0, t: 0, l: 0 } };
    for (let w = startWeek; w <= endWeek; w++) {
        const val = team.weeklyMatchWins[w];
        if (val === undefined) continue;
        const bucket = rec[getWeekTier(team, w)] || rec.reg;
        if (val === 1) bucket.w++;
        else if (val === 0.5) bucket.t++;
        else bucket.l++;
    }
    return rec;
}

function formatRecord(rec) {
    return `${rec.w}W-${rec.l}L-${rec.t}T`;
}

// One team's row in the Rankings standings. A single bar scaled to the team's TOTAL across the selected range, split into one segment per bracket tier: regular season in the team's own color, playoffs shaded darker, consolation shaded lighter (see tierColor).
function buildStandingsBarRowHtml({ teamId, name, color, split, overallMax, recordByTier }) {
    const widthPct = overallMax > 0 ? (split.total / overallMax) * 100 : 0;
    const isChampion = teamId === AppState.championTeamId;

    // With W-L-T records available, a tier counts as present if any weeks were PLAYED in it (an 0-2 playoff run is real information even though it contributes 0 wins, the old sub-bar design surfaced it too). The width floor below keeps it a visible sliver.
    const tierPlayed = (tier) => recordByTier
        ? (recordByTier[tier].w + recordByTier[tier].t + recordByTier[tier].l) > 0
        : split[tier] > 0;
    let parts = ['reg', 'playoff', 'consolation'].filter(tierPlayed).map(tier => ({
        tier,
        val: split[tier],
        label: recordByTier ? formatRecord(recordByTier[tier]) : split[tier].toFixed(1)
    }));

    const totalLabel = recordByTier
        ? formatRecord({
            w: recordByTier.reg.w + recordByTier.playoff.w + recordByTier.consolation.w,
            t: recordByTier.reg.t + recordByTier.playoff.t + recordByTier.consolation.t,
            l: recordByTier.reg.l + recordByTier.playoff.l + recordByTier.consolation.l
        })
        : split.total.toFixed(1);

    // Defensive: a team with no played weeks in the range still renders one segment, so the row shows .bar-fill's min-width nub with a tooltip instead of a blank track.
    if (parts.length === 0) parts = [{ tier: 'reg', val: 0, label: totalLabel }];

    // Segment widths are each tier's share of this bar's own total, floored so a played-but- zero-value tier stays a visible sliver, then re-normalized to sum back to 100.
    const MIN_SEGMENT_PCT = 6;
    let widths = parts.map(p => split.total > 0 ? Math.max((p.val / split.total) * 100, MIN_SEGMENT_PCT) : 100 / parts.length);
    const widthSum = widths.reduce((sum, w) => sum + w, 0);
    widths = widths.map(w => (w / widthSum) * 100);

    const segmentsHtml = parts.map((p, i) => {
        const champTag = isChampion && p.tier === 'playoff' ? ' - Champion' : '';
        const tip = `${TIER_LABELS[p.tier]}: ${p.label}${champTag}`;
        return `<div class="bar-segment" style="width:${widths[i]}%; background:${tierColor(p.tier, color)};" data-tooltip="${escapeHtml(tip)}"></div>`;
    }).join('');

    const labelHidden = isBarTooSmallForLabel(widthPct, totalLabel);
    return `
        <div class="bar-row-group">
            <div class="bar-row">
                <span class="bar-title" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <div class="bar-track">
                    <div class="bar-fill" style="width:${widthPct}%;">
                        ${segmentsHtml}
                        ${labelHidden ? '' : `<span class="bar-value-label">${totalLabel}</span>`}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Incremented on every renderLeftColumn() call. See its use in the deferred inline-pie placement measurement below.
let leftColumnRenderId = 0;

// The Rankings box (right-hand 40% column) shows one of two views, switched by its header tabs (AppState.rankingsBoxView, set in main.js): Team Rankings. The standings bars (H2H Match Wins / Category Wins) plus pie charts. Or Category Rankings plus its own category picker (#cat-filters).
export function renderLeftColumn() {
    const isCategory = AppState.rankingsBoxView === 'category';
    updateRankingsBoxChrome(isCategory);
    if (isCategory) {
        renderCategoryGraph();
        return;
    }
    renderStandings();
}

// Point the Rankings box's chrome at the active view: which header tab reads as active, the Bar Charts/Pie Charts dropdown (Team Rankings-only), and which of the two graph containers plus the category picker are shown. renderStandings' deferred pass may still hide the pie dropdown when inline pies fit. This just sets the standings-mode baseline (visible) for it to start from.
function updateRankingsBoxChrome(isCategory) {
    const tabStandings = document.getElementById('rankings-tab-standings');
    const tabCategory = document.getElementById('rankings-tab-category');
    if (tabStandings) tabStandings.classList.toggle('active', !isCategory);
    if (tabCategory) tabCategory.classList.toggle('active', isCategory);

    const pieSelector = document.getElementById('pie-selector');
    if (pieSelector) pieSelector.style.display = isCategory ? 'none' : '';

    document.getElementById('left-graph-container').style.display = isCategory ? 'none' : 'flex';
    document.getElementById('cat-graph-container').style.display = isCategory ? 'flex' : 'none';
    const catFilters = document.getElementById('cat-filters');
    if (catFilters) catFilters.style.display = isCategory ? '' : 'none';
}

function renderStandings() {
    const graph = document.getElementById('left-graph-container');
    graph.innerHTML = '';

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);

    // At a single matchup a season-long H2H Match Wins ranking is meaningless (every team's result is its own undecided 1/0). The Matchup Scoreboard owns that story in the trends box (see renderScoreboardBox), so this box shows the one ranking still real for a single week: who won the most categories.
    if (startWeek === endWeek && !AppState.isPointsLeague) {
        document.getElementById('pie-selector').style.display = 'none';
        renderSingleWeekBars(graph, startWeek, true, false, { intro: null });

        // Same no-scroll guarantee as the multi-week path below, minus the pie-placement step.
        const renderId = ++leftColumnRenderId;
        requestAnimationFrame(() => {
            if (renderId !== leftColumnRenderId) return;
            graph.classList.remove('bars-compact');
            if (graph.scrollHeight > graph.clientHeight + 1) graph.classList.add('bars-compact');
        });
        return;
    }

    const leftData = AppState.teamStats.map(t => {
        let mWins = 0, cWins = 0;
        for (let w = startWeek; w <= endWeek; w++) {
            mWins += t.weeklyMatchWins[w] || 0;
            cWins += t.weeklyCatWins[w] || 0;
        }
        return { id: t.id, name: t.name, mWins, cWins, team: t };
    });

    if (leftData.length === 0) return;

    // The Rankings column's own Rankings/Pie Charts dropdown. A full content swap for the whole box.
    if (document.getElementById('pie-selector').value === 'pies') {
        renderPieChartsView(graph, leftData);
        return;
    }

    const h2hTeams = [...leftData].sort((a, b) => b.mWins - a.mWins);
    const h2hSplits = h2hTeams.map(tv => splitByTier(tv.team, startWeek, endWeek, w => tv.team.weeklyMatchWins[w]));
    const h2hMax = Math.max(...h2hSplits.map(s => s.total));

    let h2hHtml = `
        <div class="team-block" style="border-bottom: 1px solid var(--border); margin-bottom: 4px; padding-bottom: 4px;">
            <h4 style="margin: 0 0 4px 0; border-bottom: 2px solid var(--border); padding-bottom: 4px; color: var(--text-body); font-size: 14px;">H2H Match Wins</h4>
    `;
    h2hTeams.forEach((tv, i) => {
        // Deliberately NOT filtered by AppState.visibleTeams. Unlike the Season Trends/Category Rankings graphs on the right, this is a full-league standings view, and hiding a team here would strip the ranking/"games back" context for everyone else too.
        const recordByTier = AppState.isPointsLeague ? null : computeRecordByTier(tv.team, startWeek, endWeek);

        h2hHtml += buildStandingsBarRowHtml({
            teamId: tv.id, name: tv.name, color: AppState.teamColorMap[tv.id],
            split: h2hSplits[i], overallMax: h2hMax, recordByTier
        });
    });
    h2hHtml += `</div>`;

    let catHtml = '';
    if (!AppState.isPointsLeague) {
        const catTeams = [...leftData].sort((a, b) => b.cWins - a.cWins);
        const catSplits = catTeams.map(tv => splitByTier(tv.team, startWeek, endWeek, w => tv.team.weeklyCatWins[w]));
        const catMax = Math.max(...catSplits.map(s => s.total));

        catHtml = `
            <div class="team-block" style="border-bottom: none; margin-bottom: 0; padding-bottom: 0;">
                <h4 style="margin: 0 0 4px 0; border-bottom: 2px solid var(--border); padding-bottom: 4px; color: var(--text-body); font-size: 14px;">Category Wins</h4>
        `;
        catTeams.forEach((tv, i) => {
            // Same as H2H Match Wins above. Not filtered by AppState.visibleTeams.
            catHtml += buildStandingsBarRowHtml({
                teamId: tv.id, name: tv.name, color: AppState.teamColorMap[tv.id],
                split: catSplits[i], overallMax: catMax, recordByTier: null
            });
        });
        catHtml += `</div>`;
    }

    graph.innerHTML = `
        <div style="flex: 0 0 auto; width: 100%;">
            ${h2hHtml}
            ${catHtml}
        </div>
    `;

    attachDataTooltips(graph);

    // Dynamic pie placement: an early, playoff-less season (few rows, no postseason sub-bars) leaves a lot of unused grey space below the bars, while a season with playoffs active barely fits (or doesn't). So there's no single fixed spot that works well for both.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;

        // No-scroll guarantee: if the bars at normal density would overflow the viewport, step the whole column down to a compact row style (thinner tracks, tighter margins, smaller type, see .bars-compact in dashboard.css) BEFORE deciding whether inline pies also fit.
        graph.classList.remove('bars-compact');
        if (graph.firstElementChild.getBoundingClientRect().height > graph.clientHeight) {
            graph.classList.add('bars-compact');
        }

        // graph.scrollHeight is NOT usable here. Per spec it's never smaller than clientHeight, so when the bars are SHORTER than the viewport (exactly the case we're trying to detect) it just reports clientHeight right back, always reading as "zero leftover".
        const pieSelector = document.getElementById('pie-selector');
        const barsHeight = graph.firstElementChild.getBoundingClientRect().height;
        const leftover = graph.clientHeight - barsHeight;
        const hasRoomForInlinePies = leftover >= INLINE_PIE_MIN_HEIGHT;

        pieSelector.style.display = hasRoomForInlinePies ? 'none' : '';
        if (hasRoomForInlinePies && !renderInlinePies(graph, leftData, leftover)) {
            // The pies never found a size that actually fit (see renderInlinePies). Fall back to the dropdown instead of leaving the page scrollable.
            pieSelector.style.display = '';
        }
    });
}

// Shared by renderInlinePies and renderPieChartsView: calls renderAtSize(size) at decreasing sizes (fixed 10px steps) until `container`'s content fits without overflowing (no internal scroll needed), or gives up once size hits minSize.
function shrinkPiesToFit(container, renderAtSize, initialSize, minSize = 50, step = 10) {
    let size = initialSize;
    renderAtSize(size);
    while (container.scrollHeight > container.clientHeight + 1 && size > minSize) {
        size -= step;
        renderAtSize(size);
    }
    return container.scrollHeight > container.clientHeight + 1 ? null : size;
}

// Compact side-by-side pies appended right below the bars, only reached when renderLeftColumn found enough leftover room for them.
function renderInlinePies(graph, leftData, leftover) {
    // Scale to fill the ACTUAL leftover space instead of a small fixed size. A couple of teams a few weeks into a fresh season can leave 300px+ below the bars, and capping the pies at a conservative fixed size just left most of that as unused grey padding around them.
    const pieCount = AppState.isPointsLeague ? 1 : 2;
    const maxByHeight = leftover - 50;
    const maxByWidth = (graph.clientWidth / pieCount) - 60;
    const initialSize = Math.max(70, Math.min(INLINE_PIE_MAX_SIZE, maxByHeight, maxByWidth));

    const pieDataMatch = leftData.map(t => ({ id: t.id, name: t.name, val: t.mWins, color: AppState.teamColorMap[t.id] }));
    const pieDataCat = AppState.isPointsLeague ? null : leftData.map(t => ({ id: t.id, name: t.name, val: t.cWins, color: AppState.teamColorMap[t.id] }));

    // flex:1 (not 0 0 auto) so the row absorbs ALL the leftover space below the bars and the pies sit centered within it (align-items), rather than hugging the bars' bottom edge and leaving every spare pixel as a lopsided gap underneath.
    const pieRow = document.createElement('div');
    pieRow.style.cssText = 'display:flex; justify-content:space-around; align-items:center; margin-top:10px; padding-top:10px; border-top:1px dashed var(--border); flex:1 1 auto; min-height:0; width:100%;';
    graph.appendChild(pieRow);

    const renderAtSize = (s) => {
        const pieMatchHtml = createPieChart(pieDataMatch, 'H2H Distribution', s);
        const pieCatHtml = pieDataCat ? createPieChart(pieDataCat, 'Cat Wins Distribution', s) : '';
        pieRow.innerHTML = pieMatchHtml + pieCatHtml;
    };

    // The estimate above isn't pixel-exact (rounding, borders, a title that wraps at a narrow size, etc.). shrinkPiesToFit re-measures and steps down rather than giving up on inline pies (and the room they clearly have) after one failed guess.
    if (shrinkPiesToFit(graph, renderAtSize, initialSize) === null) {
        pieRow.remove();
        return false;
    }

    // Scoped to just the new row. attachDataTooltips(graph) would work too, but would also re-scan and re-attach listeners to the bars above, which already got them a few lines up.
    attachDataTooltips(pieRow);
    attachPieTooltipLogic();
    return true;
}

// The "Pie Charts" alternative to the Rankings bars above. Both distributions side by side (not stacked, this box is usually wider than it is tall, and stacking made the fixed-size pies overflow the box on anything but a tall window), sized to fit via the same iterative shrink-to-fit renderInlinePies uses.
function renderPieChartsView(graph, leftData) {
    const pieDataMatch = leftData.map(t => ({ id: t.id, name: t.name, val: t.mWins, color: AppState.teamColorMap[t.id] }));
    const pieDataCat = AppState.isPointsLeague ? null : leftData.map(t => ({ id: t.id, name: t.name, val: t.cWins, color: AppState.teamColorMap[t.id] }));
    const pieCount = pieDataCat ? 2 : 1;

    graph.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:row; flex-wrap:wrap; justify-content:space-around; align-items:center; flex:1 1 auto; min-height:0; width:100%;';
    graph.appendChild(wrap);

    const maxByHeight = graph.clientHeight - 50;
    const maxByWidth = (graph.clientWidth / pieCount) - 60;
    const initialSize = Math.max(70, Math.min(INLINE_PIE_MAX_SIZE, maxByHeight, maxByWidth));

    const renderAtSize = (s) => {
        const pieMatchHtml = createPieChart(pieDataMatch, 'H2H Distribution', s);
        const pieCatHtml = pieDataCat ? createPieChart(pieDataCat, 'Cat Wins Distribution', s) : '';
        wrap.innerHTML = pieMatchHtml + pieCatHtml;
    };

    // Unlike renderInlinePies (which can fall back to hiding these behind the dropdown), this function IS the selected view. There's nowhere else to fall back to, so an unfittable floor size (an extremely short window) still renders at the floor rather than a blank box.
    if (shrinkPiesToFit(graph, renderAtSize, initialSize) === null) {
        renderAtSize(50);
    }

    attachDataTooltips(graph);
    attachPieTooltipLogic();
}

function createPieChart(data, title, size = 80) {
    const total = data.reduce((sum, d) => sum + d.val, 0);
    if (total === 0) return '';

    let svg = `<svg viewBox="-100 -100 200 200" style="width: ${size}px; height: ${size}px; overflow: visible;">`;
    let currentAngle = -Math.PI / 2;

    data.forEach(d => {
        if (d.val <= 0) return;
        const sliceAngle = (d.val / total) * 2 * Math.PI;

        const endAngle = currentAngle + sliceAngle;
        const largeArcFlag = sliceAngle > Math.PI ? 1 : 0;

        const x1 = Math.cos(currentAngle) * 100;
        const y1 = Math.sin(currentAngle) * 100;
        const x2 = Math.cos(endAngle) * 100;
        const y2 = Math.sin(endAngle) * 100;

        let pathData;
        if (sliceAngle >= 2 * Math.PI - 0.0001) {
            pathData = `M 0 -100 A 100 100 0 1 1 0 100 A 100 100 0 1 1 0 -100 Z`;
        } else {
            pathData = `M 0 0 L ${x1} ${y1} A 100 100 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;
        }

        const pct = ((d.val / total) * 100).toFixed(1);
        const tooltip = `${d.name}: ${d.val.toFixed(1)} (${pct}%)`;

        svg += `<path d="${pathData}" fill="${d.color}" class="pie-slice" data-tooltip="${escapeHtml(tooltip)}" stroke-width="2" style="stroke:var(--surface-2); cursor:help; transition: opacity 0.2s;" />`;
        currentAngle = endAngle;
    });
    svg += `</svg>`;

    return `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; flex: 1;">
            <div style="font-weight:bold; font-size:12px; color:var(--text-muted); margin-bottom:6px;">${title}</div>
            ${svg}
        </div>
    `;
}

// Pie slices get their own hover-dim effect on top of the tooltip positioning that attachDataTooltips already provides (every caller of this function calls attachDataTooltips against the same container first, each slice carries its own [data-tooltip] attribute, set in createPieChart). This only adds the opacity change, it doesn't duplicate the positioning logic attachDataTooltips already handles.
function attachPieTooltipLogic() {
    const container = document.getElementById('left-graph-container');
    if (!container) return;

    container.querySelectorAll('.pie-slice').forEach(slice => {
        slice.addEventListener('mouseenter', () => { slice.style.opacity = '0.7'; });
        slice.addEventListener('mouseleave', () => { slice.style.opacity = '1'; });
    });
}

// The left "col-trends" column is Season Trends only.
export function renderRightColumn() {
    const container = document.getElementById('line-graph-container');
    container.style.display = 'flex';

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const isScoreboard = startWeek === endWeek && !AppState.isPointsLeague;
    updateTrendsBoxChrome(isScoreboard);

    if (isScoreboard) {
        renderScoreboardBox(container, startWeek);
    } else {
        renderTrendGraph();
    }
}

// Swaps the col-trends box's h3 title + tooltip between its two roles (see renderRightColumn). A <span id> inside the existing markup rather than a second header element, so no layout shifts when the content underneath changes.
function updateTrendsBoxChrome(isScoreboard) {
    const title = document.getElementById('trends-box-title');
    const tooltip = document.getElementById('trends-box-tooltip');
    if (title) title.textContent = isScoreboard ? 'Matchup Scoreboard' : 'Season Trends';
    if (tooltip) tooltip.textContent = isScoreboard
        ? "This week's matchups, category by category. The winning side of each is bolded. Switch to a wider timeframe for the season trend line."
        : 'Cat Wins and Match Wins using the selected timeframe. The dashed line marks when playoffs started. Hover any point to get a breakdown.';
}

// The Category Heatmap is now a permanent full-width band below the two columns (always visible at every timeframe, timeframe-aware, see the .heatmap-band layout in dashboard.html), rather than a right-column dropdown view.
export function renderHeatmapBand() {
    const container = document.getElementById('heatmap-graph-container');
    if (!container) return;
    renderDominanceHeatmap(container);
}

// The league's scored categories that actually have data anywhere in a week range, in the stat map's own order (batting group before pitching for baseball), each tagged with whether it's a rate stat (decimals, aggregated by averaging) and whether lower is better.
function scoredCategoriesInRange(startWeek, endWeek) {
    const sport = document.getElementById('sport').value;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const avgSet = AVERAGE_STATS[sport] || new Set();
    const invSet = INVERSE_STATS[sport] || new Set();
    const hasData = id => AppState.teamStats.some(t => {
        for (let w = startWeek; w <= endWeek; w++) if (t.weeklyCats[w] && t.weeklyCats[w][id] !== undefined) return true;
        return false;
    });
    return Object.keys(statMap)
        .filter(id => AppState.scoredStatIds.has(id))
        .filter(hasData)
        .map(id => ({ id, name: statMap[id], isAvg: avgSet.has(id), inverse: invSet.has(id) }));
}

// A team's value in one category over a week range. Summed for counting stats, averaged over the weeks actually played for rate stats (AVG, ERA, ...).
function aggregateTeamCategory(team, catId, isAvg, startWeek, endWeek) {
    let sum = 0, weeks = 0;
    for (let w = startWeek; w <= endWeek; w++) {
        if (team.weeklyCats[w] && team.weeklyCats[w][catId] !== undefined) { sum += team.weeklyCats[w][catId]; weeks++; }
    }
    if (weeks === 0) return undefined;
    return isAvg ? sum / weeks : sum;
}

// Display value for a category cell. rate/average stats (AVG, ERA, WHIP, ...) keep decimals, counting stats show as whole numbers.
function formatCatValue(v) {
    if (v === undefined || v === null) return '-';
    return (v % 1 !== 0) ? v.toFixed(3) : v;
}

function formatCatScore(v) {
    return (v % 1 !== 0) ? v.toFixed(1) : v;
}

// How "close" a category was between the two sides of a matchup, used by the row-cap ladder step (maxCatRows below) to pick which categories stay visible when not all fit.
function computeCatMargin(hv, av) {
    if (hv === undefined || av === undefined) return Infinity;
    const scale = Math.max(Math.abs(hv), Math.abs(av), 1e-9);
    return Math.abs(hv - av) / scale;
}

// Head-to-Head Scoreboard (single-matchup timeframe, category leagues).
function buildH2HScoreboardHtml(week, maxCatRows = null) {
    const games = (AppState.apiData?.schedule || []).filter(g =>
        g.matchupPeriodId === week && g.home && g.away && g.home.teamId != null && g.away.teamId != null);
    if (games.length === 0) return '';

    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });
    const cats = scoredCategoriesInRange(week, week);

    const cards = games.map(g => {
        const home = teamById[g.home.teamId];
        const away = teamById[g.away.teamId];
        if (!home || !away) return '';
        const hScore = home.weeklyCatWins[week] || 0;
        const aScore = away.weeklyCatWins[week] || 0;

        let shownCats = cats;
        let hiddenCount = 0;
        if (maxCatRows != null && cats.length > maxCatRows) {
            const byMargin = cats
                .map(c => ({ c, margin: computeCatMargin(home.weeklyCats[week]?.[c.id], away.weeklyCats[week]?.[c.id]) }))
                .sort((a, b) => a.margin - b.margin);
            const keepIds = new Set(byMargin.slice(0, maxCatRows).map(x => x.c.id));
            shownCats = cats.filter(c => keepIds.has(c.id));
            hiddenCount = cats.length - shownCats.length;
        }

        const catRows = shownCats.map(c => {
            const hv = home.weeklyCats[week]?.[c.id];
            const av = away.weeklyCats[week]?.[c.id];
            let homeWin = false, awayWin = false;
            if (hv !== undefined && av !== undefined && hv !== av) {
                (c.inverse ? hv < av : hv > av) ? homeWin = true : awayWin = true;
            } else if (hv !== undefined && av === undefined) homeWin = true;
            else if (av !== undefined && hv === undefined) awayWin = true;
            return `
                <div class="h2h-cat-row">
                    <span class="h2h-cat-val h2h-cat-home${homeWin ? ' h2h-cat-win' : ''}">${formatCatValue(hv)}</span>
                    <span class="h2h-cat-name">${escapeHtml(c.name)}</span>
                    <span class="h2h-cat-val h2h-cat-away${awayWin ? ' h2h-cat-win' : ''}">${formatCatValue(av)}</span>
                </div>`;
        }).join('');
        const moreRow = hiddenCount > 0
            ? `<div class="h2h-cat-more">+${hiddenCount} more in the heatmap below</div>`
            : '';

        const headTeam = (team, cls, winning) => `
            <div class="h2h-head-team ${cls}${winning ? ' h2h-head-lead' : ''}">
                <span class="h2h-dot" style="background:${AppState.teamColorMap[team.id]};"></span>
                <span class="h2h-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
            </div>`;

        return `
            <div class="h2h-card">
                <div class="h2h-head">
                    ${headTeam(home, 'h2h-head-home', hScore > aScore)}
                    <span class="h2h-head-score">${formatCatScore(hScore)}<span class="h2h-head-dash">-</span>${formatCatScore(aScore)}</span>
                    ${headTeam(away, 'h2h-head-away', aScore > hScore)}
                </div>
                <div class="h2h-cats">${catRows}${moreRow}</div>
            </div>`;
    }).join('');

    return `<div class="h2h-grid">${cards}</div>`;
}

// Lowest category-row cap the ladder's last-resort step will settle for. Even a genuinely huge league still shows at least this many real rows per card rather than an almost-all-"+K more" card that stops being useful.
const SCOREBOARD_ROW_FLOOR = 3;

// Superseded-render guard for renderScoreboardBox's deferred ladder measurement, same pattern as leftColumnRenderId above.
let scoreboardRenderId = 0;

// Renders the Matchup Scoreboard into the col-trends box and runs a no-scroll degradation ladder: (a) normal density -> (b) compact rows -> (c) two-column category rows inside each card -> (d) cap visible rows per card to the tightest-margin categories.
function renderScoreboardBox(container, week) {
    const totalCats = scoredCategoriesInRange(week, week).length;
    const html = buildH2HScoreboardHtml(week);
    if (!html) {
        container.innerHTML = buildEmptyStateHtml('No matchups scheduled for this week.');
        return;
    }
    container.innerHTML = html;
    attachDataTooltips(container);

    const grid = container.firstElementChild;
    const renderId = ++scoreboardRenderId;
    requestAnimationFrame(() => {
        if (renderId !== scoreboardRenderId) return;

        grid.classList.remove('h2h-compact', 'h2h-two-col');
        if (container.scrollHeight <= container.clientHeight + 1) return;

        grid.classList.add('h2h-compact');
        if (container.scrollHeight <= container.clientHeight + 1) return;

        grid.classList.add('h2h-two-col');
        if (container.scrollHeight <= container.clientHeight + 1) return;

        // A fixed guess can't know real row heights, so step the cap down one category at a time and re-measure for real.
        for (let cap = totalCats - 1; cap >= SCOREBOARD_ROW_FLOOR; cap--) {
            container.innerHTML = buildH2HScoreboardHtml(week, cap);
            attachDataTooltips(container);
            const newGrid = container.firstElementChild;
            if (newGrid) newGrid.classList.add('h2h-compact', 'h2h-two-col');
            if (container.scrollHeight <= container.clientHeight + 1) break;
        }
    });
}

// Category Heatmap. A teams x scored-categories grid, each cell a team's value aggregated over the SELECTED TIMEFRAME (see aggregateTeamCategory), shaded by its rank among the visible teams in that category (green = leading the league, red = last, inverse-aware so a low ERA reads green).
function renderDominanceHeatmap(container) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks);
    const teams = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));
    const cats = scoredCategoriesInRange(start, end);

    if (teams.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team above to compare.');
        return;
    }
    if (cats.length === 0) {
        container.innerHTML = buildEmptyStateHtml('No category data for this timeframe yet.');
        return;
    }

    // Aggregate every team's value in every category over the range, then rank per category by competition rank (ties share) among the teams that have a value. Inverse categories rank the lowest value best.
    const valByCat = {};
    const pctByCat = {};
    cats.forEach(c => {
        const vByTeam = {};
        teams.forEach(t => {
            const v = aggregateTeamCategory(t, c.id, c.isAvg, start, end);
            if (v !== undefined) vByTeam[t.id] = v;
        });
        valByCat[c.id] = vByTeam;

        const vals = Object.entries(vByTeam).map(([id, v]) => ({ id, v }));
        const n = vals.length;
        const sorted = vals.sort((a, b) => c.inverse ? a.v - b.v : b.v - a.v);
        const ranks = [];
        const pct = {};
        for (let i = 0; i < sorted.length; i++) {
            ranks[i] = (i > 0 && sorted[i].v === sorted[i - 1].v) ? ranks[i - 1] : i + 1;
            pct[sorted[i].id] = { pct: n > 1 ? ((n - ranks[i]) / (n - 1)) * 100 : 100, rank: ranks[i], total: n };
        }
        pctByCat[c.id] = pct;
    });

    const headCells = cats.map(c => `<th title="${escapeHtml(c.name)}${c.inverse ? ' (lower is better)' : ''}">${escapeHtml(c.name)}${c.inverse ? ' <span class="dh-inv">&darr;</span>' : ''}</th>`).join('');
    const bodyRows = teams.map(t => {
        const cells = cats.map(c => {
            const v = valByCat[c.id][t.id];
            if (v === undefined) return `<td class="dh-empty">-</td>`;
            const info = pctByCat[c.id][t.id];
            const tip = `${escapeHtml(t.name)} · ${escapeHtml(c.name)}: ${formatCatValue(v)} (#${info.rank} of ${info.total})`;
            return `<td class="dh-cell" style="background:${percentileColor(info.pct)};" data-tooltip="${escapeHtml(tip)}">${formatCatValue(v)}</td>`;
        }).join('');
        return `
            <tr>
                <td class="dh-team" title="${escapeHtml(t.name)}">
                    <span class="dh-dot" style="background:${AppState.teamColorMap[t.id]};"></span>${escapeHtml(t.name)}
                </td>
                ${cells}
            </tr>`;
    }).join('');

    container.innerHTML = `
        <div style="width:100%;">
            <div class="dh-wrap">
                <table class="dominance-heatmap">
                    <thead><tr><th class="dh-team-head">Team</th>${headCells}</tr></thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        </div>`;
    attachDataTooltips(container);
}

// intro is the italic explainer line above the bars. Defaults to the "no trend line" framing used by renderTrendGraph's points-league single-week fallback. renderStandings' single-matchup Category Wins branch reuses this builder inside the Rankings box, where that framing doesn't apply. It passes intro: null.
function renderSingleWeekBars(container, week, showCat, showMatch, { intro = 'Single-matchup timeframe selected - showing a direct comparison instead of a trend line.' } = {}) {
    const teams = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));

    const buildBlock = (title, mapKey) => {
        const rows = teams.map(t => ({ id: t.id, name: t.name, val: t[mapKey][week] || 0, team: t })).sort((a, b) => b.val - a.val);
        if (rows.length === 0) return '';

        const minVal = Math.min(...rows.map(r => r.val));
        const maxVal = Math.max(...rows.map(r => r.val));
        const leaderVal = rows[0].val;

        let html = `<div class="team-block">${buildBlockHeaderHtml(`${title} - Matchup ${week}`)}`;
        rows.forEach((r, idx) => {
            const split = splitByTier(r.team, week, week, w => r.team[mapKey][w]);
            html += buildComparisonBarRowHtml({
                name: r.name, val: r.val, color: AppState.teamColorMap[r.id],
                minVal, maxVal, leaderVal, isLeader: idx === 0, split
            });
        });
        html += `</div>`;
        return html;
    };

    let content = '';
    if (showCat && !AppState.isPointsLeague) {
        content += buildBlock('Category Wins', 'weeklyCatWins');
    }
    if (showMatch || AppState.isPointsLeague) {
        content += buildBlock(AppState.isPointsLeague ? 'Points' : 'Match Wins', 'weeklyMatchWins');
    }

    if (!content) {
        content = buildEmptyStateHtml('Enable at least one metric above to compare this matchup.');
    }

    const introHtml = intro
        ? `<div style="font-size: 11px; color: var(--text-subtle); margin-bottom: 10px; font-style: italic;">${intro}</div>`
        : '';

    container.innerHTML = `
        <div style="width: 100%;">
            ${introHtml}
            ${content}
        </div>
    `;
    attachDataTooltips(container);
}

function renderTrendGraph() {
    const container = document.getElementById('line-graph-container');
    container.innerHTML = '';

    const showCat = document.getElementById('toggle-cat').checked;
    const showMatch = document.getElementById('toggle-match').checked;
    const tfVal = AppState.timeframe;
    const { start: startWeek, end: endWeek } = getTimeframeBounds(tfVal, AppState.maxCompletedWeek, AppState.regSeasonWeeks);

    // A line "trend" needs at least two weeks to plot.
    if (startWeek === endWeek) {
        renderSingleWeekBars(container, startWeek, showCat, showMatch);
        return;
    }

    const svgWidth = 800;
    const svgHeight = 350;
    const padding = 45;

    let maxCat = 0, maxMatch = 0;

    AppState.teamStats.forEach(t => {
        let cSum = 0, mSum = 0;
        for (let w = startWeek; w <= endWeek; w++) {
            cSum += (t.weeklyCatWins[w] || 0);
            mSum += (t.weeklyMatchWins[w] || 0);
            if (cSum > maxCat) maxCat = cSum;
            if (mSum > maxMatch) maxMatch = mSum;
        }
    });

    maxCat = getNiceMax(maxCat);
    maxMatch = getNiceMax(maxMatch);

    let svgStr = `<svg id="trend-svg" width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" style="display: block; cursor: crosshair; flex: 1;">`;
    const numWeeks = endWeek - startWeek;
    const formatTick = (val) => val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);

    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;

        if (showCat && !AppState.isPointsLeague) {
            svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatTick(maxCat - (i / 4) * maxCat)}</text>`;
        }
        if (showMatch || AppState.isPointsLeague) {
            svgStr += `<text x="${svgWidth - padding + 5}" y="${y + 4}" font-size="12" text-anchor="start" style="fill:var(--chart-axis)">${formatTick(maxMatch - (i / 4) * maxMatch)}</text>`;
        }
    }

    svgStr += `<line id="hover-line" y1="${padding}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="4,2" display="none" pointer-events="none" style="stroke:var(--chart-axis)" />`;

    if (numWeeks > 0 && AppState.regSeasonWeeks >= startWeek && AppState.regSeasonWeeks < endWeek) {
        const boundaryX = padding + ((AppState.regSeasonWeeks + 0.5 - startWeek) / numWeeks) * (svgWidth - padding * 2);
        svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1" stroke-dasharray="3,3" style="stroke:var(--chart-boundary)" />`;
        svgStr += `<text x="${boundaryX + 4}" y="${padding - 6}" font-size="10" text-anchor="start" style="fill:var(--text-faint)">Playoffs</text>`;
    }

    if (numWeeks > 0) {
        // A label per week works fine for a short range, but crams together and overlaps once "Regular Season + Playoffs" spans 20+ weeks. Thin them out to a fixed max count, evenly spaced, always including the last week so the range's end is clear.
        const maxLabels = 10;
        const labelStep = Math.max(1, Math.ceil((numWeeks + 1) / maxLabels));
        for (let w = startWeek; w <= endWeek; w++) {
            if ((w - startWeek) % labelStep !== 0 && w !== endWeek) continue;
            let x = padding + ((w - startWeek) / numWeeks) * (svgWidth - padding * 2);
            svgStr += `<text x="${x}" y="${svgHeight - 10}" font-size="12" text-anchor="middle" style="fill:var(--chart-axis)">M${w}</text>`;
        }
    }

    const hoverData = {};
    for (let w = startWeek; w <= endWeek; w++) hoverData[w] = [];

    // The line itself stays one consistent style throughout. The dashed "Playoffs" boundary marker above is enough to show where the playoffs start.
    AppState.teamStats.forEach((t) => {
        if (!AppState.visibleTeams.has(t.id)) return;
        const color = AppState.teamColorMap[t.id];

        let cSum = 0, mSum = 0;
        let ptsCat = [], ptsMatch = [];

        for (let w = startWeek; w <= endWeek; w++) {
            cSum += (t.weeklyCatWins[w] || 0);
            mSum += (t.weeklyMatchWins[w] || 0);

            let x = padding + (numWeeks === 0 ? 0 : ((w - startWeek) / numWeeks) * (svgWidth - padding * 2));
            let yCatVal = null, yMatchVal = null;
            const tier = getWeekTier(t, w);

            if (showCat && !AppState.isPointsLeague) {
                yCatVal = svgHeight - padding - (cSum / maxCat) * (svgHeight - padding * 2);
                ptsCat.push(`${x},${yCatVal}`);
            }
            if (showMatch || AppState.isPointsLeague) {
                yMatchVal = svgHeight - padding - (mSum / maxMatch) * (svgHeight - padding * 2);
                ptsMatch.push(`${x},${yMatchVal}`);
            }

            hoverData[w].push({ name: t.name, abbrev: t.abbrev, color, cSum, mSum, yCat: yCatVal, yMatch: yMatchVal, tier });
        }

        if (showCat && !AppState.isPointsLeague) {
            svgStr += `<polyline points="${ptsCat.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" />`;
            ptsCat.forEach(p => { const [px, py] = p.split(','); svgStr += `<circle cx="${px}" cy="${py}" r="4" fill="${color}" />`; });
        }
        if (showMatch || AppState.isPointsLeague) {
            svgStr += `<polyline points="${ptsMatch.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="6,4" />`;
            ptsMatch.forEach(p => { const [px, py] = p.split(','); svgStr += `<rect x="${px - 3}" y="${py - 3}" width="6" height="6" fill="${color}" />`; });
        }
    });

    svgStr += `</svg>`;

    Object.keys(hoverData).forEach(w => hoverData[w].sort((a, b) => b.mSum - a.mSum));

    container.innerHTML = `
        <div style="position:relative; width:100%; height:100%; display: flex;">
            ${svgStr}
            <div id="trend-tooltip" style="position:absolute; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:nowrap; box-shadow: 0 4px 12px rgba(0,0,0,0.3);"></div>
        </div>
    `;

    const svgEl = document.getElementById('trend-svg');
    const tooltipEl = document.getElementById('trend-tooltip');
    const hoverLine = document.getElementById('hover-line');

    svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const padPx = (padding / svgWidth) * rect.width;
        const chartWidthPx = Math.max(1, rect.width - (2 * padPx));

        let xRelative = e.clientX - rect.left - padPx;
        let ratio = Math.max(0, Math.min(1, xRelative / chartWidthPx));

        const hoveredWeekIndex = numWeeks === 0 ? 0 : Math.round(ratio * numWeeks);
        const w = startWeek + hoveredWeekIndex;

        const data = hoverData[w];
        if (!data || data.length === 0) return;

        const lineX = padding + (numWeeks === 0 ? 0 : (hoveredWeekIndex / numWeeks) * (svgWidth - padding * 2));
        const lineXPx = (lineX / svgWidth) * rect.width;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        let isNearPoint = false;
        for (let d of data) {
            if (d.yCat !== null && Math.hypot(lineXPx - mouseX, (d.yCat / svgHeight) * rect.height - mouseY) < 15) isNearPoint = true;
            if (d.yMatch !== null && Math.hypot(lineXPx - mouseX, (d.yMatch / svgHeight) * rect.height - mouseY) < 15) isNearPoint = true;
        }

        if (!isNearPoint) {
            tooltipEl.style.display = 'none';
            hoverLine.setAttribute('display', 'none');
            return;
        }

        if (numWeeks > 0) {
            hoverLine.setAttribute('x1', lineX);
            hoverLine.setAttribute('x2', lineX);
            hoverLine.setAttribute('display', 'block');
        }

        let html = `<div style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">Cumulative Stats Thru Matchup ${w}</div>`;
        data.forEach(d => {
            const tierTag = d.tier === 'playoff' ? ' <span style="color:#ffb84d;font-size:9px;font-weight:normal;">(Playoff)</span>'
                : d.tier === 'consolation' ? ' <span style="color:#999;font-size:9px;font-weight:normal;">(Consolation)</span>'
                : '';
            html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="display:inline-block; width:12px; height:12px; background:${d.color}; border-radius:2px;"></span>
                <span style="width: 44px; overflow: hidden; text-overflow: ellipsis; font-weight: bold;">${escapeHtml(d.abbrev)}${tierTag}</span>
                <span style="font-weight:bold;">`;
            let vals = [];
            if (showCat && !AppState.isPointsLeague) vals.push(`${d.cSum.toFixed(1)} <span style="color:#aaa;font-weight:normal;font-size:10px;">CAT</span>`);
            if (showMatch || AppState.isPointsLeague) vals.push(`${d.mSum.toFixed(1)} <span style="color:#aaa;font-weight:normal;font-size:10px;">WINS</span>`);
            html += vals.join(' &nbsp;|&nbsp; ') + `</span></div>`;
        });

        tooltipEl.innerHTML = html;
        tooltipEl.style.display = 'block';

        let tipX = e.clientX - rect.left + 20;
        let tipY = e.clientY - rect.top + 20;

        if (tipX + tooltipEl.offsetWidth > rect.width) tipX = e.clientX - rect.left - tooltipEl.offsetWidth - 20;
        if (tipY + tooltipEl.offsetHeight > rect.height) tipY = e.clientY - rect.top - tooltipEl.offsetHeight - 20;

        tooltipEl.style.left = tipX + 'px';
        tooltipEl.style.top = tipY + 'px';
    });

    svgEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
        hoverLine.setAttribute('display', 'none');
    });
}

// Incremented on every renderCategoryGraph() call. Superseded-render guard for its deferred compaction measurement, same pattern as leftColumnRenderId above.
let catGraphRenderId = 0;

function renderCategoryGraph() {
    const container = document.getElementById('cat-graph-container');
    container.innerHTML = '';

    const checkboxes = document.querySelectorAll('.cat-check:checked');
    if (checkboxes.length === 0 || !AppState.teamStats.length) {
        container.innerHTML = buildEmptyStateHtml('Pick a category below to compare teams.');
        return;
    }

    const sport = document.getElementById('sport').value;
    const avgStatsForSport = AVERAGE_STATS[sport] || new Set();
    const inverseStatsForSport = INVERSE_STATS[sport] || new Set();

    const selectedStats = Array.from(checkboxes).map(cb => ({ id: cb.value, name: cb.dataset.name }));
    const visibleTeamsList = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));

    if (visibleTeamsList.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    const tfVal = AppState.timeframe;
    const { start: startWeek, end: endWeek } = getTimeframeBounds(tfVal, AppState.maxCompletedWeek, AppState.regSeasonWeeks);

    // Each selected category becomes one ranking block.
    const blocks = [];

    selectedStats.forEach(stat => {
        let teamVals = visibleTeamsList.map(team => {
            let val = 0;
            let sum = 0, weeksPlayed = 0;
            for (let w = startWeek; w <= endWeek; w++) {
                if (team.weeklyCats[w] && team.weeklyCats[w][stat.id] !== undefined) {
                    sum += team.weeklyCats[w][stat.id];
                    weeksPlayed++;
                }
            }
            val = (avgStatsForSport.has(stat.id.toString()) && weeksPlayed > 0) ? (sum / weeksPlayed) : sum;

            return { id: team.id, name: team.name, val: val, team };
        });

        if (inverseStatsForSport.has(stat.id.toString())) {
            teamVals = teamVals.filter(tv => tv.val > 0).sort((a, b) => a.val - b.val);
        } else {
            teamVals.sort((a, b) => b.val - a.val);
        }

        if (teamVals.length === 0) return;

        const minVal = Math.min(...teamVals.map(tv => tv.val));
        const maxVal = Math.max(...teamVals.map(tv => tv.val));
        const leaderVal = teamVals[0].val;

        let blockHtml = buildBlockHeaderHtml(`${stat.name} Rankings`);

        const formatVal = (v) => (v % 1 !== 0) ? v.toFixed(3) : v;

        teamVals.forEach((tv, idx) => {
            const split = splitByTier(tv.team, startWeek, endWeek, w => (tv.team.weeklyCats[w] ? tv.team.weeklyCats[w][stat.id] : 0));
            blockHtml += buildComparisonBarRowHtml({
                name: tv.name, val: tv.val, color: AppState.teamColorMap[tv.id],
                minVal, maxVal, leaderVal, isLeader: idx === 0, split, formatVal
            });
        });

        blocks.push(blockHtml);
    });

    // Two blocks: a row of equal halves.
    const isSplit = blocks.length === 2;
    const blockStyle = isSplit ? 'flex: 1 1 0; min-width: 0;' : 'flex: 0 0 auto;';
    const blocksHtml = blocks.map(b =>
        `<div class="team-block" style="${blockStyle} border-bottom: none; margin-bottom: 0; padding-bottom: 0;">${b}</div>`
    ).join('');
    container.innerHTML = `
        <div class="${isSplit ? 'cat-split' : ''}" style="display: flex; flex-direction: ${isSplit ? 'row' : 'column'}; gap: 14px; width: 100%;${isSplit ? ' align-items: flex-start;' : ''}">
            ${blocksHtml}
        </div>`;
    attachDataTooltips(container);

    // Same no-scroll treatment as renderLeftColumn's bars (see its comment): if the rows at normal density overflow this viewport, step down to the compact row style.
    const renderId = ++catGraphRenderId;
    requestAnimationFrame(() => {
        if (renderId !== catGraphRenderId) return;
        container.classList.remove('bars-compact');
        if (container.scrollHeight > container.clientHeight + 1) {
            container.classList.add('bars-compact');
        }
    });
}