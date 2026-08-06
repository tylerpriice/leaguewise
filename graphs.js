import { AppState, AVERAGE_STATS, INVERSE_STATS, ESPN_STAT_MAPS } from './state.js';
import { getZoomedFillPct, getTimeframeBounds, getNiceMax, getWeekTier, tierColor, splitByTier, escapeHtml, attachDataTooltips, percentileColor, orderStatIdsByRole, splitStatIdsByRole, statValue, layoutHoverTooltip, categoryCycleList, categoryHeaderLabel, axisUnit, parseTimeframe } from './utils.js';
import { buildRotoRaceSeries, ensureWeeklyDataForRace, weeklyDataFailed, ensureRosterTransactionData, ensureRosterSnapshotData, activeRotoWindow, computeRotoWindow, rotoCategorySeries, rotoCategoryDailySeries } from './players.js';

const TIER_LABELS = { reg: 'Regular Season', playoff: 'Playoffs', consolation: 'Consolation' };

// A section pie is drawn at this size and then scaled to its section's real box by sizeSectionPies. The viewBox is fixed, so the placeholder value only has to be sane, not right.
const SECTION_PIE_BASE_SIZE = 120;
// Breathing room between the pie and its section's edges, and the floor below which the pie stops being worth drawing as anything but a token (a very short section on a very short window).
const SECTION_PIE_PAD = 12;
const SECTION_PIE_MIN_SIZE = 48;
// Headroom held back from the row budget. Rows, borders and the header's line box all resolve at sub-pixel sizes that round UP into the container's integer scrollHeight, so fitting the box exactly still produces a scrollbar; this is the margin that keeps the total honestly under it.
const STD_FIT_SLACK = 6;
const STD_PITCH_TINY = 20;
// Clear space between stacked bars. Without it the tracks butt together at a shrunk pitch and the column reads as one striped block instead of one bar per team (owner).
const STD_ROW_GAP = 2;

// ONE separation rule for every fitted bar ladder in the box - the standings sections and the category rows alike. The owner's point is that the two tabs are the same league drawn twice, so a 20-team category column has no business butting its bars together when the 20-team standings column beside it holds a clean 1px line. Keyed off the PITCH rather than the tab, so a tab switch or a timeframe change can only alter this separation by way of altering the density, which is the only reason it should ever move. The 1px floor is not cosmetic. At the tiny pitch the gaps cost more height than the bars do (36px of gap against 20px of bar in a 131px box), and spending 2px there is what used to force a scrollbar the fit could never clear.
function rowGapFor(pitch) {
    return pitch < STD_PITCH_TINY ? 1 : STD_ROW_GAP;
}

// The league's STANDARD separation between bars, in px, published by the standings ladder and adopted by the category rows (owner, follow-up: "where possible the gaps should be standardized... for example between team rankings and category rankings. If the available space does not permit then smaller ones can be used"). The standings ladder is the publisher because it is always the denser of the two - it draws two sections of the league where the category tab draws one - so the rhythm it can afford is a rhythm the category tab can afford too, and matching it costs the category only race height rather than costing the standings a fit. Direction matters and was decided by measurement, not taste. In the 6-team fixture the standings box is nearly full at its natural 6px rhythm (17px of slack in a 390px box), so standardizing DOWNWARD to the category's 2px would have left ~57px of the box hollow, while standardizing upward costs that league's race 20px of a 142px band. Filling the box wins. Null until a VISIBLE standings render measures one. A hidden container has no height, and a gap read off it would be the 1px famine value applied to every league. { gap, pitch, rows } - the last standings ladder's rhythm, its row height, and how many rows it had to place. The gap is adopted unconditionally; the PITCH is adopted only when the category tab is placing the same number of rows ( follow-up 2, owner: "This Matchup... both pages display the same amount of bar graphs while one is smaller vertically than the other"). Row count is the qualifier because it is what makes the two comparable. In the season view the standings ladder places two sections of the league against the category tab's one, so identical row heights there would mean the category leaving most of its box empty for no reason.
let leagueLadder = null;
// What an UNFITTED standings ladder shows, straight from `.bar-row-group { margin-bottom }`. Only the two views' render order makes this necessary. The Rankings box renders one view at a time, so a league whose category tab is drawn before its standings tab has nothing published yet. Defaulting to the roomy rhythm rather than the fitted one is the right guess, because the fitted rhythm only happens in leagues dense enough that the standings tab has to be visited to get there. Keep in sync with that CSS rule.
const STD_NATURAL_GAP = 6;

// .bar-fill deliberately isn't overflow:hidden (see that rule's own comment) so a value label too wide for its own bar spills out past the bar's edge instead of being silently clipped - but for a REALLY short bar (e.g. a team off to an 0-2 start), "spills out" means overlapping the team name column beside it, which isn't much better than clipping was. Below this width, a label isn't rendered inline at all - the value is exposed as a hover tooltip instead (the existing data-tooltip/attachDataTooltips mechanism used elsewhere in this file).

// Renders a bar's fill as one segment per tier present in `split`, each with its own data-tooltip so hovering a shaded portion shows that portion's own total. When the value comes from a single tier (the common case), it collapses to one segment whose tooltip is the full comparison-to-leader text instead of a redundant per-tier breakdown. The team name is left out - the bar-title label and color swatch already identify the row. Used by the single-week comparison bars and the Category Rankings graph on the right column - the left column's H2H Match Wins / Category Wins standings use buildStandingsBarRowHtml instead (linear 0-to-max scale, per-tier W-L-T records, played-tier slivers).
function buildBarSegments(split, baseColor, overallTooltip, formatVal = (v) => v.toFixed(1), forceSolid = false) {
    const { reg, playoff, consolation, total } = split;
    const tierVals = [
        { val: reg, tier: 'reg' },
        { val: playoff, tier: 'playoff' },
        { val: consolation, tier: 'consolation' }
    ];
    const parts = tierVals.filter(p => p.val > 0);

    // A NEGATIVE tier component (a losing +/- stretch, say) breaks the per-tier proportions below: total is the NET, so sizing the surviving positive segments against it makes them sum to MORE than 100% of the fill, and.bar-fill deliberately doesn't clip (see its value-label note), so the colored bar drew past its own end - a worse +/- rendered LONGER. There is no honest way to show a tier split as proportions when one tier is negative, so collapse to one solid segment: fillPct already encodes the net value correctly and monotonically, and the per-tier numbers move into the tooltip. Coloured by the dominant POSITIVE tier so it still reads its context (reg when the net is all negative). forceSolid extends this to the whole block: the caller sets it when ANY team in the block has a negative tier, so an all-positive row in a +/- block goes solid too and the block never mixes shaded and solid bars.
    const hasNegative = reg < 0 || playoff < 0 || consolation < 0;
    if (forceSolid || hasNegative) {
        const domTier = parts.length ? parts.reduce((a, b) => b.val > a.val ? b : a).tier : 'reg';
        const breakdown = tierVals.filter(p => p.val !== 0).map(p => `${formatVal(p.val)} ${TIER_LABELS[p.tier]}`).join(', ');
        const tip = breakdown ? `${overallTooltip} (${breakdown})` : overallTooltip;
        return `<div class="bar-segment" style="width:100%; background:${tierColor(domTier, baseColor)};" data-tooltip="${escapeHtml(tip)}"></div>`;
    }

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

// Shared "Section Title" header for a team-block - used by both the single-week comparison bars and the Category Rankings graph, which otherwise build their block markup independently. nowrap + ellipsis is load-bearing, not cosmetic. The category fit budget (renderCategoryBlocks) assumes this header is exactly one line tall, and a category whose spelled-out name wraps to two would silently overrun the box by a row's worth of height. The full text stays on the title tooltip, so an ellipsized header never loses the answer. THE section header for every block in the Rankings box, both tabs. There used to be two: this one, a bare inline-styled h4, and the standings sections' own.std-head row - and they disagreed on the margin below (10px vs 4px), the padding above the underline (6px vs 4px), and therefore on where the underline sat and where the content under it began. Switching tabs moved the header AND shifted the first row of bars, which is exactly the jump banned everywhere else in this box. One helper, one class, so the two tabs are pixel-identical down to the first row. `trailing` is anything pinned to the header's right edge (the standings sections' bars/pie flip arrow). Passing nothing gives the plain header the category blocks want.
function buildBlockHeaderHtml(title, trailing = '') {
    return `
        <div class="section-head">
            <h4 title="${escapeHtml(title)}">${escapeHtml(title)}</h4>
            ${trailing}
        </div>`;
}

// Shared "nothing to show" placeholder - used wherever a graph box has no content to render because of the user's own current filter selection (no metric toggled on, no category checked, every team hidden), rather than a real data problem.
function buildEmptyStateHtml(message) {
    return `<div style="color: var(--text-subtle); text-align: center; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 14px;">${message}</div>`;
}

// One team's row in a bar-comparison block - shared by renderSingleWeekBars (single-matchup Category Wins/Match Wins) and renderCategoryGraph (Category Rankings), which differ only in how they compute val/split/formatVal for their rows, not in how a row itself is built.
function buildComparisonBarRowHtml({ name, abbrev, val, color, minVal, maxVal, leaderVal, isLeader, split, formatVal = (v) => v.toFixed(1), forceSolid = false }) {
    const fillPct = getZoomedFillPct(val, minVal, maxVal);
    const displayVal = formatVal(val);
    const overallTooltip = isLeader
        ? `${displayVal}: Leader`
        : `${displayVal}: ${formatVal(Math.abs(leaderVal - val))} back`;
    const segments = buildBarSegments(split, color, overallTooltip, formatVal, forceSolid);

    return `
        <div class="bar-row">
            ${buildBarTitleHtml(name, abbrev)}
            <div class="bar-track">
                <div class="bar-fill" style="width:${fillPct}%;">
                    ${segments}
                </div>
            </div>
            <span class="bar-value">${displayVal}</span>
        </div>
    `;
}

// The row's team label. Both the full name and the league's own abbreviation ship in the markup and CSS picks one (see.cat-2col), the same trick the matchup cards use. The two-column layout is decided per render, and carrying both means the choice costs no rebuild. The abbreviation is a real short name rather than an ellipsized long one, which is what makes a half-width row still say WHO; the full name stays on the title tooltip either way. Falls back to the full name when the league never set an abbreviation.
function buildBarTitleHtml(name, abbrev) {
    const short = abbrev || name;
    return `<span class="bar-title" title="${escapeHtml(name)}"
        ><span class="bar-title-full">${escapeHtml(name)}</span
        ><span class="bar-title-abbr">${escapeHtml(short)}</span></span>`;
}

// One team's VERTICAL column in a single-matchup ranking. Horizontal rows are as tall as their own text and then stop, so a 4-team league left a third of the Rankings box as grey (88px of 264 at 2 matchups). Columns fill BOTH axes instead - the chart takes the whole available height and the columns divide the whole width. `fillPct` uses the same getZoomedFillPct scale the rows use, so switching orientation never changes what the ranking says, only how it reads. A single-matchup window is one tier by definition, so a column is one solid fill rather than the rows' tier segments.
function buildVerticalColumnHtml({ name, val, color, minVal, maxVal, leaderVal, isLeader, formatVal }) {
    const fillPct = getZoomedFillPct(val, minVal, maxVal);
    const displayVal = formatVal(val);
    const tip = isLeader
        ? `${escapeHtml(name)}: ${displayVal} (leader)`
        : `${escapeHtml(name)}: ${displayVal}, ${formatVal(Math.abs(leaderVal - val))} back`;
    return `
        <div class="vcol${isLeader ? ' vcol-leader' : ''}" data-tooltip="${tip}">
            <span class="vcol-value">${displayVal}</span>
            <div class="vcol-track">
                <div class="vcol-fill" style="height:${fillPct}%; background:${color};"></div>
            </div>
            <span class="vcol-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        </div>`;
}

// W-L-T match record, broken down by tier, for a Match Wins bar - a "record" is clearer there than a raw decimal sum of 1/0.5/0 weekly results. resultAt reads the 1/0.5/0 result for a week: category leagues store it in weeklyMatchWins, points leagues in weeklyMatchResult (weeklyMatchWins there holds points, not results - see data.js), so the caller passes the right accessor.
function computeRecordByTier(team, startWeek, endWeek, resultAt = (t, w) => t.weeklyMatchWins[w]) {
    const rec = { reg: { w: 0, t: 0, l: 0 }, playoff: { w: 0, t: 0, l: 0 }, consolation: { w: 0, t: 0, l: 0 } };
    for (let w = startWeek; w <= endWeek; w++) {
        const val = resultAt(team, w);
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

// One team's row in the Rankings standings - a single bar scaled to the team's TOTAL across the selected range, split into one segment per bracket tier, regular season in the team's own color, playoffs shaded darker, consolation shaded lighter (the same tier-shading language the Category Rankings bars and Season Trends hover tags already use - see tierColor). Every segment carries its own tooltip with that tier's value (or W-L-T record, for H2H in category leagues), and the label baked into the bar is the range total. This replaces an older two-row design (a regular-season-only bar plus an SVG connector branching into a separate postseason sub-bar aligned at a shared x position) that showed the same data but through a lot of visual machinery - connectors, sub-tracks, per-row alignment math, and a whole separate row type for the Playoffs-only timeframe. One segmented bar per team reads the same breakdown with none of that, and Playoffs-only needs no special-casing (reg is 0 there, so no reg segment renders).
function buildStandingsBarRowHtml({ teamId, name, abbrev, color, split, overallMax, recordByTier }) {
    const widthPct = overallMax > 0 ? (split.total / overallMax) * 100 : 0;
    const isChampion = teamId === AppState.championTeamId;

    // With W-L-T records available, a tier counts as present if any weeks were PLAYED in it (an 0-2 playoff run is real information even though it contributes 0 wins - the old sub-bar design surfaced it too); the width floor below keeps it a visible sliver. Without records (points leagues' H2H points, Cat Wins), only tiers that contributed value can be sized.
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

    // Defensive: a team with no played weeks in the range still renders one segment, so the row shows.bar-fill's min-width nub with a tooltip instead of a blank track.
    if (parts.length === 0) parts = [{ tier: 'reg', val: 0, label: totalLabel }];

    // Segment widths are each tier's share of this bar's own total, floored so a played-but- zero-value tier stays a visible sliver, then re-normalized to sum back to 100.
    const MIN_SEGMENT_PCT = 6;
    let widths = parts.map(p => split.total > 0 ? Math.max((p.val / split.total) * 100, MIN_SEGMENT_PCT) : 100 / parts.length);
    const widthSum = widths.reduce((sum, w) => sum + w, 0);
    widths = widths.map(w => (w / widthSum) * 100);

    const segmentsHtml = parts.map((p, i) => {
        const champTag = isChampion && p.tier === 'playoff' ? ' (Champion)' : '';
        const tip = `${TIER_LABELS[p.tier]}: ${p.label}${champTag}`;
        return `<div class="bar-segment" style="width:${widths[i]}%; background:${tierColor(p.tier, color)};" data-tooltip="${escapeHtml(tip)}"></div>`;
    }).join('');

    // The value sits in its own column at the END of the row rather than inside the fill. In the fill it was invisible on exactly the rows that most need reading - a short bar has no room for its own number, so the width guard that used to live here dropped it, and at 20 teams that was most of the league. Out here it always shows, still on the bar's own line.
    return `
        <div class="bar-row-group">
            <div class="bar-row">
                ${buildBarTitleHtml(name, abbrev)}
                <div class="bar-track">
                    <div class="bar-fill" style="width:${widthPct}%;">
                        ${segmentsHtml}
                    </div>
                </div>
                <span class="bar-value">${totalLabel}</span>
            </div>
        </div>
    `;
}

// Incremented on every renderLeftColumn() call - see its use in the deferred inline-pie placement measurement below.
let leftColumnRenderId = 0;

// The Rankings box (right-hand 40% column) shows one of two views, switched by its header tabs (AppState.rankingsBoxView, set in main.js): Team Rankings - the standings bars (H2H Match Wins / Category Wins) plus pie charts - or Category Rankings, which is now one category at a time with the pager arrows cycling the league's whole list. This dispatcher keeps the box's tabs/containers in sync with that state, then renders the active view.

export function renderLeftColumn() {
    const isCategory = AppState.rankingsBoxView === 'category';
    // Roto gets the same two views, built from ESPN's season standings instead of weekly matchups (B31-FULL): Team Rankings is the roto-points table, Category Rankings is per-category season value plus the roto points that category awarded.
    if (AppState.isRotoLeague) {
        updateRankingsBoxChrome(isCategory);
        if (isCategory) renderRotoCategoryGraph();
        else renderRotoStandings();
        return;
    }
    updateRankingsBoxChrome(isCategory);
    if (isCategory) {
        renderCategoryGraph();
        return;
    }
    renderStandings();
}

// Point the Rankings box's chrome at the active view, which header tab reads as active, which of the two graph containers is shown, and which of the two header controls occupies the slot beside the tabs. The Bar/Pie dropdown belongs to Team Rankings and the Advanced Stats toggle to Category Rankings, so they swap into the same space and neither view pays for the other's control. renderStandings' deferred pass may still hide the pie dropdown when inline pies fit; this just sets the standings-mode baseline (visible) for it to start from.
function updateRankingsBoxChrome(isCategory) {
    const tabStandings = document.getElementById('rankings-tab-standings');
    const tabCategory = document.getElementById('rankings-tab-category');
    if (tabStandings) tabStandings.classList.toggle('active', !isCategory);
    if (tabCategory) tabCategory.classList.toggle('active', isCategory);

    const advancedToggle = document.getElementById('cat-advanced-toggle');
    if (advancedToggle) advancedToggle.style.display = isCategory ? '' : 'none';

    document.getElementById('left-graph-container').style.display = isCategory ? 'none' : 'flex';
    document.getElementById('cat-graph-container').style.display = isCategory ? 'flex' : 'none';
}

function renderStandings() {
    const graph = document.getElementById('left-graph-container');
    graph.innerHTML = '';

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);

    // A single-matchup window can't make a W-L record - every team is just its own undecided 1/0 from this one week, so a whole league of "1W-0L" bars says nothing. Show the one ranking that IS real for a single week instead. Category leagues rank by categories won this matchup (the head-to-head story lives in the trends box's Matchup Scoreboard - see renderScoreboardBox), points leagues by points scored this matchup. renderSingleWeekBars picks the league-appropriate block, so the same showCat=true call covers both. No pie arrow on this timeframe. A single week has no shared season total to divide teams against, so its "distribution" would be a meaningless per-team split (B53's substitution applied to the pie view). renderSingleWeekBars builds its own block without section chrome.
    if (startWeek === endWeek) {
        renderSingleWeekBars(graph, startWeek, true, false, { intro: null });

        // Same no-scroll guarantee as the multi-week path below.
        const renderId = ++leftColumnRenderId;
        requestAnimationFrame(() => {
            if (renderId !== leftColumnRenderId) return;
            graph.classList.remove('bars-compact');
            if (graph.scrollHeight > graph.clientHeight + 1) graph.classList.add('bars-compact');
        });
        return;
    }

    // Filtered by AppState.visibleTeams. This standings view used to be deliberately full- league on the reasoning that hiding a team strips the ranking/"games back" context for the rest; the owner REVERSED that on - the Data Filters now apply to every Team Metrics box, this one included. All-hidden shows the same empty state the Category Rankings use.
    const leftData = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id)).map(t => {
        let mWins = 0, cWins = 0, pointWins = 0;
        for (let w = startWeek; w <= endWeek; w++) {
            mWins += t.weeklyMatchWins[w] || 0;
            cWins += t.weeklyCatWins[w] || 0;
            pointWins += t.weeklyMatchResult[w] || 0;
        }
        return { id: t.id, name: t.name, mWins, cWins, pointWins, team: t };
    });

    if (leftData.length === 0) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // One standings section (a header + one segmented bar per team, sorted by the section's total). Operates on leftData, which is now the VISIBLE teams only ( reversed the old full-league convention - see the leftData comment above). valueKey picks the per-team total to sort and size by; weekValue reads that team's per-week contribution; a resultAt accessor (when given) renders a W-L-T record instead of a decimal sum.
    const buildSection = ({ key, header, valueKey, weekValue, resultAt, isLast }) => {
        const teams = [...leftData].sort((a, b) => b[valueKey] - a[valueKey]);
        const asPie = sectionPieViews.has(key);
        // Bars are built either way. They set the section's height even when the pie is what shows.
        const splits = teams.map(tv => splitByTier(tv.team, startWeek, endWeek, w => weekValue(tv.team, w)));
        const overallMax = Math.max(...splits.map(s => s.total));
        const barsBody = teams.map((tv, i) => buildStandingsBarRowHtml({
            teamId: tv.id, name: tv.name, abbrev: tv.team?.abbrev, color: AppState.teamColorMap[tv.id],
            split: splits[i], overallMax,
            recordByTier: resultAt ? computeRecordByTier(tv.team, startWeek, endWeek, resultAt) : null
        })).join('');
        return buildStandingsSectionHtml({
            key, header, isLast, asPie, barsBody,
            pieBody: asPie ? buildSectionPieHtml(teams, valueKey) : ''
        });
    };

    // Points leagues get Match Wins (the real W-L record from winning weeks on points) + Points For (the points totals weeklyMatchWins holds); category leagues get H2H Match Wins + Category Wins. Both lead with a records-bearing section, so the shapes stay parallel.
    const sections = AppState.isPointsLeague
        ? [
            { key: 'match', header: 'Match Wins', valueKey: 'pointWins', weekValue: (t, w) => t.weeklyMatchResult[w] || 0, resultAt: (t, w) => t.weeklyMatchResult[w] },
            { key: 'points', header: 'Points For', valueKey: 'mWins', weekValue: (t, w) => t.weeklyMatchWins[w] || 0 }
        ]
        : [
            { key: 'h2h', header: 'H2H Match Wins', valueKey: 'mWins', weekValue: (t, w) => t.weeklyMatchWins[w] || 0, resultAt: (t, w) => t.weeklyMatchWins[w] },
            { key: 'cat', header: 'Category Wins', valueKey: 'cWins', weekValue: (t, w) => t.weeklyCatWins[w] || 0 }
        ];

    const sectionsHtml = sections.map((s, i) => buildSection({ ...s, isLast: i === sections.length - 1 })).join('');

    // The sections column FILLS the box so a section flipped to a pie has real space to expand into; bars sections stay content-sized inside it (see buildStandingsSectionHtml).
    graph.innerHTML = `<div class="std-sections">${sectionsHtml}</div>`;

    attachDataTooltips(graph);
    if (sections.some(sec => sectionPieViews.has(sec.key))) attachPieTooltipLogic();
    wireSectionFlips(graph, renderStandings);

    // Dynamic pie placement. An early, playoff-less season (few rows, no postseason sub-bars) leaves a lot of unused grey space below the bars, while a season with playoffs active barely fits (or doesn't) - so there's no single fixed spot that works well for both. When the bars leave enough leftover room, show both pies inline right below them and hide the dropdown (nothing left to switch between - everything's already visible); otherwise leave them tucked behind the dropdown's "Pie Charts" view so they don't force scrolling. Deferred to the next animation frame - measured synchronously here, this read fine on most renders but came back stale/zero on the very FIRST call of a page load (right as #results flips from display:none to visible - see processCoreData), silently skipping the inline pies entirely until some later renderLeftColumn() call (e.g. clicking a timeframe pill) measured against a layout the browser had already fully settled by then. One frame is enough to guarantee a real layout pass has happened first. renderId guards against a newer renderLeftColumn() call superseding this one before the frame fires (e.g. clicking two timeframe pills in quick succession) - only the LATEST call's measurement gets applied.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;

        // No-scroll guarantee. If the bars at normal density would overflow the box, step the whole column down to a compact row style (thinner tracks, tighter margins, smaller type - see.bars-compact in dashboard.css). Reset first so a previously-compacted render doesn't stay compact after a resize or timeframe change made room again. Order matters. The fit runs FIRST because it decides which label each row shows - two columns swap full names for abbreviations - and sizing the column before that decision measures names that are about to be replaced, which pinned the width at its 140px cap and left the whole gap this was meant to close. Pies last, since they inherit the fitted box.
        fitStandingsSections(graph);
        sizeBarTitles(graph);
        sizeSectionPies(graph);
        observeStandingsFit(graph);
    });
}

// Roto points arrive as halves whenever ESPN split a category tie, so they need one decimal when they have one and none when they don't ("3.5 pts", "5 pts").
function formatRotoPoints(v) {
    if (v === undefined || v === null) return '-';
    const num = Number(v);
    if (!Number.isFinite(num)) return '-';
    return (num % 1 !== 0) ? num.toFixed(1) : String(num);
}

// Roto Team Rankings (B31-FULL): the classic roto table in house style, ordered by ESPN's own season total. Nothing is computed here beyond the sort - see the rotoPoints comment in data.js for why these numbers are rendered exactly as the payload reports them.
function renderRotoStandings() {
    const graph = document.getElementById('left-graph-container');
    graph.innerHTML = '';

    // Full Season shows ESPN's OFFICIAL points verbatim (t.rotoPoints). A "Last N weeks" pill instead re-scores the categories over ONLY that window's started-day components - the same pure machinery the Roto Race uses, so its full-season point reproduces these official finals exactly. The window is null on Full Season and whenever the started tier isn't available (the pills only ever appear once it is, so in practice a window pill always resolves here).
    const sport = AppState.loadedSport;
    const bounds = activeRotoWindow(sport);
    const win = bounds ? computeRotoWindow(sport, bounds.start, bounds.end) : null;
    const pointsFor = t => win ? (win.pointsByTeam.get(t.id) || 0) : (t.rotoPoints || 0);

    // Filtered by AppState.visibleTeams. Like the H2H standings, this was deliberately full- league on the reasoning that hiding a team strips the ranking context; the owner REVERSED that on so the Data Filters apply to every Team Metrics box. All-hidden shows the empty state the Category Rankings use.
    const leftData = AppState.teamStats
        .filter(t => AppState.visibleTeams.has(t.id))
        .map(t => ({ id: t.id, name: t.name, rotoPoints: pointsFor(t), team: t }))
        .sort((a, b) => b.rotoPoints - a.rotoPoints);
    if (leftData.length === 0) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // Roto has ONE standings section, and it gets the same flip arrow the H2H sections do (, owner's same-day addition: "this also applies to roto points pie charts").
    const asPie = sectionPieViews.has('roto');
    const overallMax = Math.max(0, ...leftData.map(tv => tv.rotoPoints));
    const barsBody = leftData.map(tv => buildStandingsBarRowHtml({
        teamId: tv.id, name: tv.name, abbrev: tv.team?.abbrev, color: AppState.teamColorMap[tv.id],
        // Roto has no bracket, so the bar is a single regular-season segment rather than a tier split - there is no postseason for it to shade differently.
        split: { reg: tv.rotoPoints, playoff: 0, consolation: 0, total: tv.rotoPoints },
        overallMax, recordByTier: null
    })).join('');

    graph.innerHTML = `
        <div class="std-sections">
            ${buildStandingsSectionHtml({
                key: 'roto', header: 'Roto Points', isLast: true, asPie, barsBody,
                pieBody: asPie ? buildSectionPieHtml(leftData, 'rotoPoints') : ''
            })}
        </div>`;
    attachDataTooltips(graph);
    if (asPie) attachPieTooltipLogic();
    wireSectionFlips(graph, renderRotoStandings);

    // Same deferred pass the H2H standings run - see renderStandings.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;
        fitStandingsSections(graph);
        sizeBarTitles(graph);
        sizeSectionPies(graph);
        observeStandingsFit(graph);
    });
}

// Roto Category Rankings (B31-FULL): one block per picked category, teams ordered by the roto points THAT category awarded, with the season total behind it. Ordering by points rather than by raw value is what makes this match ESPN's own table without a separate inverse branch. An inverse category like GAA awards its points to the LOWEST value, and the points already encode that, so sorting on them is correct in both directions. The bar length follows the points for the same reason - it is the one number that is comparable across categories - and the season total rides along in the label and the hover.
function renderRotoCategoryGraph() {
    const container = document.getElementById('cat-graph-container');
    container.innerHTML = '';

    // Every category the league has, in role-grouped order - the pager cycles them one per screen. No selection state, because there is nothing to pick and nothing to restore.
    const sport = AppState.loadedSport;
    const selectedStats = categoryCycleList(sport);
    if (selectedStats.length === 0 || !AppState.teamStats.length) {
        container.innerHTML = buildEmptyStateHtml('No category data for this league yet.');
        return;
    }
    const visibleTeamsList = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));
    if (visibleTeamsList.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // Full Season reads ESPN's official per-category points/values; a "last N weeks" pill re-scores over the window's started-day components, the same data the Team Rankings and heatmap window against. period names the timeframe in the hover so the number is never oversold.
    const bounds = activeRotoWindow(sport);
    const win = bounds ? computeRotoWindow(sport, bounds.start, bounds.end) : null;
    const period = win ? 'in this window' : 'for the season';
    const valFor = (team, id) => win ? win.catValuesByTeam.get(team.id)?.[id] : team.seasonCats[id];
    const ptsFor = (team, id) => win ? win.pointsByStatByTeam.get(team.id)?.[id] : team.rotoPointsByStat[id];

    const blocks = [];

    selectedStats.forEach(stat => {
        const teamVals = visibleTeamsList
            .map(team => ({
                id: team.id, name: team.name, abbrev: team.abbrev, team,
                val: valFor(team, stat.id),
                pts: ptsFor(team, stat.id)
            }))
            .filter(tv => tv.val !== undefined || tv.pts !== undefined)
            .sort((a, b) => (b.pts || 0) - (a.pts || 0));
        if (teamVals.length === 0) return;

        const maxPts = Math.max(0, ...teamVals.map(tv => tv.pts || 0));
        const minPts = Math.min(...teamVals.map(tv => tv.pts || 0));
        // Just the stat name - the box is already titled "Category Rankings", so "+/- Rankings" here is redundant. "+/-" heads its own block.
        const rowsHtml = [];

        teamVals.forEach(tv => {
            const pts = tv.pts || 0;
            const fillPct = getZoomedFillPct(pts, minPts, maxPts);
            // Exactly one point reads "1 pt", everything else (including a half) takes the plural.
            const unit = pts === 1 ? 'pt' : 'pts';
            const label = `${formatRotoPoints(pts)} ${unit}`;
            const tip = `${tv.name} · ${stat.name}: ${formatCatValue(tv.val)} ${period}, ${formatRotoPoints(pts)} roto ${unit}`;
            const segments = buildBarSegments(
                { reg: pts, playoff: 0, consolation: 0, total: pts },
                AppState.teamColorMap[tv.id], tip, formatRotoPoints
            );
            rowsHtml.push(`
                <div class="bar-row">
                    ${buildBarTitleHtml(tv.name, tv.abbrev)}
                    <div class="bar-track">
                        <div class="bar-fill" style="width:${fillPct}%;">
                            ${segments}
                        </div>
                    </div>
                    <span class="bar-value">${label}</span>
                </div>`);
        });
        // Roto DOES race now. rotoCategorySeries walks the same started-day component sums the bars above are scored from, week by week. On a fallback tier it returns null and the block has no race, which is the honest answer - those tiers count benched days ESPN never did, so their per-week shape would be wrong.
        blocks.push({
            id: String(stat.id),
            name: stat.name,
            inverse: (INVERSE_STATS[sport] || new Set()).has(String(stat.id)),
            header: buildBlockHeaderHtml(categoryHeaderLabel(sport, stat.id, stat.name)),
            rowsHtml,
            race: buildCategoryRaceSeries(stat.id, teamVals, 0, 0)
        });
    });

    renderCategoryBlocks(container, blocks);
}

// One standings SECTION: its header row (title plus the flip arrow) and whichever body it is currently showing. moved the pies here from two places that no longer exist - the Bar/Pie header dropdown that swapped the WHOLE box, and the inline pies that used to be appended under the bars whenever they left enough room. The owner's ruling is that a pie is one section's alternate view, never a thing that appears beneath its bars, and each section flips on its own. The arrow is the Category Rankings chrome (.chrome-arrow), and there is no position indicator because a two-state cycle does not need one - the arrow alone says "there is another view". A pie section takes flex:1 so it FILLS the space it was given, while a bars section stays content-sized exactly as before; that is what lets one section flip without moving the other.
function buildStandingsSectionHtml({ key, header, isLast, asPie, barsBody, pieBody }) {
    const seam = isLast
        ? 'border-bottom: none; margin-bottom: 0; padding-bottom: 0;'
        : 'border-bottom: 1px solid var(--border); margin-bottom: 4px; padding-bottom: 4px;';
    const label = asPie ? `Show ${header} as bars` : `Show ${header} as a pie chart`;
    // The BARS are always in the markup, even when the pie is the one on screen, and the pie is laid over them (see.std-section.is-pie in dashboard.css). That is what makes flipping cost zero geometry: the section's height is always the height its bars need, so the pie is exactly as big as the area the bars occupied and neither this section nor its neighbour moves by a pixel (owner, ). Sizing a pie by its own content instead made the section grow on flip - measured 191px of bars becoming a 276px pie section, shoving everything below it down.
    return `
        <div class="team-block std-section${asPie ? ' is-pie' : ''}" style="${seam}">
            ${buildBlockHeaderHtml(header, `<button type="button" class="chrome-arrow std-flip" data-section="${escapeHtml(key)}"
                    title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${asPie ? '&#8249;' : '&#8250;'}</button>`)}
            <div class="std-body">
                <div class="std-bars">${barsBody}</div>
                ${asPie ? `<div class="std-pie">${pieBody}</div>` : ''}
            </div>
        </div>`;
}

// A section's pie: the SAME numbers its bars show, read straight off the same sorted rows and the same valueKey, so the two views can never disagree about who leads. Rendered at a placeholder size and resized once against the section's real box in sizeSectionPies below - the viewBox is fixed, so setting width/height scales it exactly with no re-render and no iteration.
function buildSectionPieHtml(teams, valueKey) {
    const data = teams.map(t => ({
        id: t.id,
        name: t.name,
        val: t[valueKey] || 0,
        color: AppState.teamColorMap[t.id]
    }));
    const pie = createPieChart(data, '', SECTION_PIE_BASE_SIZE);
    // Every team at zero (an unplayed category, a filtered-down window) - createPieChart draws nothing rather than a fake full circle, so say so instead of leaving the section blank.
    if (!pie) return buildEmptyStateHtml('No totals to split for this timeframe yet.');
    return `<div class="std-pie">${pie}</div>`;
}

// Sizes every pie in the box, once, after layout. Two rules, from the owner's two requirements: 1. FLIPPING MOVES NOTHING. The pie is drawn over the area its own bars occupy, so a section that fits keeps exactly the height it had as bars and its neighbour never shifts. 2. A PIE NEVER NEEDS SCROLLING. A deep league's bars legitimately overflow the box and scroll; the pie is a single circle that has no reason to. So a pie section's reserved height is capped at its share of the visible box, and past that the bars underneath are clipped (they are invisible in this state anyway). On the 20-team fixture that is the difference between a pie drawn 800px down inside a scrolling section and one sitting in the visible band. The two rules only ever disagree when the bars overflow, which is exactly the case where rule 2 should win, since nothing is "moving" that the reader could have seen anyway.
function sizeSectionPies(graph) {
    const pieSections = [...graph.querySelectorAll('.std-section.is-pie')];
    if (pieSections.length === 0) return;
    // A couple of px per section of slack. The header's line box and the seam borders round in ways that put two exactly-computed caps a hair over the box (4px of overflow with the arithmetic otherwise summing to exactly the box height).
    const share = Math.floor(graph.clientHeight / pieSections.length) - 3;

    pieSections.forEach(section => {
        const body = section.querySelector('.std-body');
        const bars = section.querySelector('.std-bars');
        const holder = section.querySelector('.std-pie');
        const svg = holder && holder.querySelector('svg');
        if (!body || !bars || !holder || !svg) return;

        // Measure the bars' natural height with any previous cap lifted, so a re-render never compounds the cap on itself.
        body.style.maxHeight = '';
        const natural = bars.getBoundingClientRect().height;
        // Everything in the section that ISN'T the body, its header plus the seam (margin, padding, border) to the next section. Built up from those parts rather than subtracted from the section's own height, because sections are flex-SHRINKABLE - in a deep league the section measures smaller than its content, so the subtraction went negative and handed the cap a huge number (a 326px pie in a 388px box, overflowing by 179px).
        const headCs = section.querySelector('.section-head');
        const secCs = getComputedStyle(section);
        const seam = (parseFloat(secCs.marginBottom) || 0)
            + (parseFloat(secCs.paddingBottom) || 0)
            + (parseFloat(secCs.borderBottomWidth) || 0);
        const overhead = (headCs ? headCs.getBoundingClientRect().height : 0) + seam;
        const cap = Math.max(SECTION_PIE_MIN_SIZE + SECTION_PIE_PAD, share - overhead);

        // Cap ONLY when the bars actually overrun their share. Applying it unconditionally shaved a few px off sections that already fit, because a rect does not include the last bar row's trailing margin - measured on the roto fixture, a 160px section became 154px on flip, with nothing overflowing to justify it. Leaving maxHeight unset in that case is what makes rule 1 exact rather than approximate.
        body.style.maxHeight = natural > cap ? `${Math.round(cap)}px` : '';

        // Measured after the cap decision, so it reflects the box the pie actually got.
        const holderBox = holder.getBoundingClientRect();
        const size = Math.max(SECTION_PIE_MIN_SIZE, Math.floor(Math.min(holderBox.width, holderBox.height)) - SECTION_PIE_PAD);
        svg.style.width = `${size}px`;
        svg.style.height = `${size}px`;
    });

    // These caps land AFTER fitStandingsSections already made its own corrective pass, so its arithmetic could not have accounted for them. Trim once more here if the box still overruns (6px with both sections pies in a box the Data Filters bar had just shrunk).
    for (let guard = 0; guard < 6; guard++) {
        // Converge to ZERO, not to "close enough". scrollHeight/clientHeight are integers, so a single leftover pixel is a real scrollbar - tolerating 1px here is what left the box showing one after everything else about the fit was correct (owner).
        const over = graph.scrollHeight - graph.clientHeight;
        if (over <= 0) break;
        const trim = Math.ceil(over / pieSections.length);
        pieSections.forEach(section => {
            const body = section.querySelector('.std-body');
            const svg = section.querySelector('.std-pie svg');
            if (!body) return;
            const h = Math.max(SECTION_PIE_MIN_SIZE, body.getBoundingClientRect().height - trim);
            body.style.maxHeight = `${Math.round(h)}px`;
            if (svg) {
                const px = Math.max(SECTION_PIE_MIN_SIZE, Math.floor(h) - SECTION_PIE_PAD);
                svg.style.width = `${px}px`;
                svg.style.height = `${px}px`;
            }
        });
    }
}

// Fits EVERY standings row into the box, the same ruling settled for category blocks. A team is never hidden behind a scrollbar, and the bar height yields to make that true. Ladder, in order: 1. One column at the rows' natural height (the comfortable case, left completely untouched). 2. Two columns at that height, filling DOWN then across so the ranking still reads top to bottom. 3. Shrink the pitch until every row fits; below STD_PITCH_TINY the row also sheds its value label to the hover and drops to the small type. The pitch is SHARED across the sections so Match Wins and Points For stay visually parallel. This also closes the overlap this box shipped with..std-section is content-sized, so a section can never be squeezed under its own rows. It used to be flex-shrinkable while its rows were not, which let a 514px bars list render inside a 183px section and paint straight over the section below it - measured on a 20-team league, section one's rows ran 357px into section two.
function fitStandingsSections(graph) {
    const sections = [...graph.querySelectorAll('.std-section')];
    const barsEls = sections.map(s => s.querySelector('.std-bars')).filter(b => b && b.children.length);
    if (barsEls.length === 0) return;

    // Clear the previous fit first, so every measurement below is of the natural layout rather than of whatever the last render talked it into.
    barsEls.forEach(bars => {
        bars.classList.remove('std-fit', 'std-2col', 'std-tiny');
        bars.style.gridTemplateRows = '';
        bars.style.removeProperty('--std-pitch');
    });

    const rowCounts = barsEls.map(b => b.children.length);
    const naturalPitch = Math.max(...barsEls.map((b, i) => b.getBoundingClientRect().height / rowCounts[i]));

    // Everything in the box that is not a row, each section's header and the seam to the next.
    let overhead = 0;
    sections.forEach(sec => {
        const head = sec.querySelector('.section-head');
        const cs = getComputedStyle(sec);
        overhead += (head ? head.getBoundingClientRect().height : 0)
            + (parseFloat(cs.marginBottom) || 0)
            + (parseFloat(cs.paddingBottom) || 0)
            + (parseFloat(cs.borderBottomWidth) || 0);
    });
    const slotsFor = cols => rowCounts.reduce((sum, n) => sum + Math.ceil(n / cols), 0);
    // The inter-row gaps are real height, one fewer than the rows in each section's tallest column.
    const gapsFor = cols => barsEls.reduce((sum, _, i) => sum + Math.max(0, Math.ceil(rowCounts[i] / cols) - 1), 0);
    const availFor = (cols, gap) => graph.clientHeight - overhead - STD_FIT_SLACK - gapsFor(cols) * gap;

    // The rhythm this render actually shows, published for the category rows to match. In the natural (unfitted) case it is the row group's own margin rather than anything computed here, which is why it is MEASURED off two adjacent rows instead of assumed - the category tab has no other way to know what the standings tab beside it looks like.
    const publishLadder = (g, p) => {
        if (graph.clientHeight > 0 && g > 0 && p > 0) {
            leagueLadder = { gap: g, pitch: p, rows: rowCounts.reduce((a, b) => a + b, 0) };
        }
    };
    const naturalGap = (() => {
        const bars = barsEls.find(b => b.children.length > 1);
        if (!bars) return 0;
        const a = bars.children[0].getBoundingClientRect();
        const b = bars.children[1].getBoundingClientRect();
        return Math.max(0, Math.round(b.top - a.bottom));
    })();

    // Rung 1: it already fits in one column. Leave the rows exactly as they render naturally - the same "cap only when capping is needed" lesson the pie sizing learned, so leagues that were fine are not nudged by a pixel.
    if (slotsFor(1) * naturalPitch <= availFor(1, rowGapFor(naturalPitch))) {
        publishLadder(naturalGap, Math.round(naturalPitch - naturalGap));
        return;
    }

    let cols = 2;
    let pitch = naturalPitch;
    let gap = rowGapFor(pitch);
    if (slotsFor(2) * naturalPitch > availFor(2, gap)) {
        pitch = Math.max(1, Math.floor(availFor(2, gap) / slotsFor(2)));
        // Shrinking can drop the pitch into tiny territory, where rowGapFor spends 1px instead of 2; re-solve once with the cheaper gap so those pixels go back to the rows.
        if (rowGapFor(pitch) !== gap) {
            gap = rowGapFor(pitch);
            pitch = Math.max(1, Math.floor(availFor(2, gap) / slotsFor(2)));
        }
    }

    const apply = (p) => barsEls.forEach((bars, i) => {
        bars.style.setProperty('--std-row-gap', `${gap}px`);
        bars.style.setProperty('--std-pitch', `${p}px`);
        bars.style.gridTemplateRows = `repeat(${Math.ceil(rowCounts[i] / cols)}, ${p}px)`;
        bars.classList.add('std-fit');
        bars.classList.toggle('std-2col', cols > 1);
        bars.classList.toggle('std-tiny', p < STD_PITCH_TINY);
    });
    apply(pitch);

    // One bounded corrective pass. The arithmetic above works from a pitch measured BEFORE the grid existed, and the grid's own row boxes round a little differently (13px of residual overflow at a pitch the maths said fit exactly). Rather than pad the estimate and under-fill every league, re-measure the real overflow and shave the pitch by it, at most a few times.
    for (let guard = 0; guard < 6 && pitch > 1; guard++) {
        // Same rule as the pie trim below, zero rather than "close enough".
        const over = graph.scrollHeight - graph.clientHeight;
        if (over <= 0) break;
        pitch = Math.max(1, pitch - Math.max(1, Math.ceil(over / slotsFor(cols))));
        apply(pitch);
    }
    // The correction can cross the tiny line after the gap was picked; re-read it off the pitch that actually shipped so the published rhythm is the one on screen.
    if (rowGapFor(pitch) !== gap) {
        gap = rowGapFor(pitch);
        apply(pitch);
    }
    publishLadder(gap, pitch);
}

// Re-runs the standings fit whenever the Rankings box's own box changes size, so the layout cannot be left holding a measurement that was true once and is not any more. The fit is a single measured pass inside a requestAnimationFrame, which assumes that one frame is enough for the layout to have settled. That assumption is not always safe - the box's height moves under it when the Data Filters bar opens, when a pop-out closes, when the window resizes, and on the very first paint as #results flips from display:none (the same first-paint staleness the pies-under-bars code documented before it was deleted). A fit computed against a stale height stays wrong until something unrelated happens to re-render the box, which is exactly the shape of "it looked right, then an interaction made it wrong, and it never recovered". Observing the CONTAINER is what makes this safe from feedback. The fit only ever changes the height of descendants, while this box's own height is set by the column that owns it, so re-fitting cannot resize the thing being watched. Idempotent by construction - fitStandingsSections clears its own previous output before measuring, so running it again with nothing changed is a no-op.
let standingsFitObserver = null;
function observeStandingsFit(graph) {
    if (standingsFitObserver || typeof ResizeObserver === 'undefined') return;
    let lastHeight = 0;
    standingsFitObserver = new ResizeObserver(() => {
        const h = graph.clientHeight;
        if (!h || h === lastHeight) return;
        lastHeight = h;
        if (!graph.querySelector('.std-section')) return;
        fitStandingsSections(graph);
        sizeBarTitles(graph);
        sizeSectionPies(graph);
    });
    standingsFitObserver.observe(graph);
}

// Sizes the team-label column to the LONGEST label actually on screen, instead of a fixed generous width. The fixed 140px was sized for full team names, so a box showing abbreviations left a wide grey channel between the label and the bar - the owner's "lots of grey space between the team abbreviation and the bar". The reclaimed width goes to the tracks, which is where the information is. One measurement for the whole container, applied to every row. A per-row width would make each bar start at a different x and turn a ranking into a ragged staircase. Measured off the inner label span, whose inline box is its natural text width regardless of the clipped parent, so no reflow dance is needed. Capped so one absurd name cannot eat the track, floored so the column never collapses to nothing.
const BAR_TITLE_MIN = 34;
const BAR_TITLE_MAX = 140;
const BAR_TITLE_PAD = 8;
const BAR_VALUE_MAX = 90;
const BAR_VALUE_PAD = 4;
// The label and value column widths the last bar view measured, so the OTHER Rankings tab can hold its own columns open to at least the same width when the two are drawing the same league.
const lastBarColumnWidths = { title: 0, value: 0 };

// `floorWidths` lets a caller hold a column open to a width another view measured. Only the twin case uses it (see renderCategoryBlocks). When both Rankings tabs draw the same league once, their tracks should end at one x, and each tab measuring only its own values put them 8px apart - "21W-4L-0T" reserves more room than a category total does.
function sizeBarTitles(container, floorWidths = null) {
    const rows = [...container.querySelectorAll('.bar-row')];
    if (rows.length === 0) return;

    let widestLabel = 0;
    container.querySelectorAll('.bar-title').forEach(title => {
        // Whichever of the two labels CSS is currently showing (full name or abbreviation).
        [...title.children].forEach(span => {
            if (span.offsetParent === null && span.offsetWidth === 0) return;
            if (getComputedStyle(span).display === 'none') return;
            widestLabel = Math.max(widestLabel, span.offsetWidth);
        });
    });
    if (widestLabel) {
        let w = Math.max(BAR_TITLE_MIN, Math.min(BAR_TITLE_MAX, Math.ceil(widestLabel) + BAR_TITLE_PAD));
        // Only a view measuring purely its own content publishes. A follower that wrote its floored width back would ratchet the column wider and never let it narrow again.
        if (!floorWidths) lastBarColumnWidths.title = w;
        else w = Math.max(w, floorWidths.title || 0);
        container.style.setProperty('--bar-title-w', `${w}px`);
    }

    // The value column gets the same treatment, and for the same reason the label column does. It is content-sized, so "21W-4L-0T" and "3W-1L-0T" reserved different widths and the TRACK beside them - the flexible element - ended at a different x on every row. The grey tracks read as a ragged right edge instead of one scale (owner). One measured width for the whole container squares them off; a per-row width is what caused the problem.
    let widestValue = 0;
    container.querySelectorAll('.bar-value').forEach(v => {
        if (getComputedStyle(v).display === 'none') return;
        widestValue = Math.max(widestValue, v.scrollWidth);
    });
    if (widestValue) {
        let w = Math.min(BAR_VALUE_MAX, Math.ceil(widestValue) + BAR_VALUE_PAD);
        if (!floorWidths) lastBarColumnWidths.value = w;
        else w = Math.max(w, floorWidths.value || 0);
        container.style.setProperty('--bar-value-w', `${w}px`);
    }
}

// Wires the per-section flip arrows. Re-attached on every render because the sections are rebuilt.
function wireSectionFlips(graph, rerender) {
    graph.querySelectorAll('.std-flip').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.section;
            if (sectionPieViews.has(key)) sectionPieViews.delete(key);
            else sectionPieViews.add(key);
            rerender();
        });
    });
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

// Pie slices get their own hover-dim effect on top of the tooltip positioning that attachDataTooltips already provides (every caller of this function calls attachDataTooltips against the same container first - each slice carries its own [data-tooltip] attribute, set in createPieChart) - this only adds the opacity change, it doesn't duplicate the positioning logic attachDataTooltips already handles.
function attachPieTooltipLogic() {
    const container = document.getElementById('left-graph-container');
    if (!container) return;

    container.querySelectorAll('.pie-slice').forEach(slice => {
        slice.addEventListener('mouseenter', () => { slice.style.opacity = '0.7'; });
        slice.addEventListener('mouseleave', () => { slice.style.opacity = '1'; });
    });
}

// Season Trends (column 2) and Category Rankings (column 3) are now separate, always-visible panels rather than one dropdown-switched view - render both every time. The trend-line metric toggles and the category picker both live in the shared, always-available Filters box at the bottom of the tab. The left "col-trends" column is now Season Trends only. Category Rankings moved into the Rankings box on the right (renderLeftColumn's category view), so this no longer touches cat-graph-container. At a single-matchup timeframe (category leagues only - see renderScoreboardBox), this column's role swaps. A season trend line needs 2+ weeks of data, so the live Matchup Scoreboard becomes the hero content instead, and the box's own header goes contextual (updateTrendsBoxChrome) so it doesn't keep reading "Season Trends" over content that has nothing to do with a trend. Points leagues are unaffected - their weeklyMatchWins IS a real single-matchup stat (raw points scored), so they keep the existing single-week bars fallback inside renderTrendGraph. The Trend Lines toggles drive the Season Trends chart's two series, whose vocabulary differs by league type. A category league toggles Cat Wins / Match Wins, a points league Points / Match Wins. The markup ships the category labels as its static default (mirror rule); this swaps the toggle-cat label to "Points" for a points league (toggle-match is "Match Wins" either way). Only the text node after the swatch is touched, so the checkbox and its swatch stay put.
function updateTrendToggleLabels() {
    const catLabel = document.getElementById('toggle-cat')?.parentElement;
    if (catLabel && catLabel.lastChild) catLabel.lastChild.textContent = AppState.isPointsLeague ? 'Points' : 'Cat Wins';
}

export function renderRightColumn() {
    const container = document.getElementById('line-graph-container');
    container.style.display = 'flex';
    updateTrendToggleLabels();

    if (AppState.isRotoLeague) {
        // The Roto Race: the standings reconstructed over the season from each team's current roster. Replaces the old "nothing to plot" notice - a box explaining its own emptiness is exactly what the owner asked never to ship.
        const title = document.getElementById('trends-box-title');
        const tooltip = document.getElementById('trends-box-tooltip');
        if (title) title.textContent = 'Roto Race';
        if (tooltip) tooltip.setAttribute('data-hint', "Each team's cumulative roto points by week, rebuilt from its current roster. ESPN keeps no roster history, so past trades shift the line.");
        renderRotoRaceGraph(container);
        return;
    }

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    // Points leagues get the scoreboard too now. They used to be excluded, which left them rendering the Rankings box's own Points bars a second time in this box - the same list twice, overflowing both. Their card carries the matchup race instead of a category breakdown.
    const isScoreboard = startWeek === endWeek;
    updateTrendsBoxChrome(isScoreboard);

    if (isScoreboard) {
        renderScoreboardBox(container, startWeek);
    } else {
        renderTrendGraph();
    }
}

// Swaps the col-trends box's h3 title + tooltip between its two roles (see renderRightColumn) - a <span id> inside the existing markup rather than a second header element, so no layout shifts when the content underneath changes. Both dashboard.html and dev-preview.html carry the same "Season Trends" text/tooltip as their static default (mirror rule) - this only overwrites it at runtime for the single-matchup case.
function updateTrendsBoxChrome(isScoreboard) {
    const title = document.getElementById('trends-box-title');
    const tooltip = document.getElementById('trends-box-tooltip');
    if (title) title.textContent = isScoreboard ? 'Matchup Scoreboard' : 'Season Trends';
    if (!tooltip) return;
    // Roto never reaches here - renderRightColumn sets its own "Roto Race" title/tooltip and returns before this runs - so this only covers the matchup box's two roles.
    tooltip.setAttribute('data-hint', isScoreboard
        ? 'This matchup, category by category. The winning side is bold. Pick a wider timeframe for the season trend.'
        : `${AppState.isPointsLeague ? 'Points' : 'Cat Wins'} and Match Wins over the selected timeframe. The dashed line marks the playoff start. Hover a point for the breakdown.`);
}

// The Category Heatmap is now a permanent full-width band below the two columns (always visible at every timeframe, timeframe-aware - see the.heatmap-band layout in dashboard.html), rather than a right-column dropdown view. Re-rendered alongside the columns wherever the timeframe or visible-team set changes (data.js processCoreData, controls.js handleTimeframeChange / legend toggle, main.js switchTab).
export function renderHeatmapBand() {
    const container = document.getElementById('heatmap-graph-container');
    if (!container) return;
    // Roto reaches the same renderer. Its season totals feed the same shading, so B61's row cap, column sorting and pop-out all work on it with no roto-specific handling (B31-FULL). The row cap is an inline-band concern only. While the band is docked in the pop-out overlay it has room for a whole league, so it renders every row there.
    renderDominanceHeatmap(container, { capRows: !isHeatmapPoppedOut() });
}

// True while the heatmap band is docked inside its pop-out overlay (main.js moves the real container node in and out - see setupHeatmapPopout).
function isHeatmapPoppedOut() {
    const slot = document.getElementById('heatmap-overlay-chart');
    const container = document.getElementById('heatmap-graph-container');
    return !!(slot && container && slot.contains(container));
}

// The league's scored categories that actually have data anywhere in a week range, ROLE-GROUPED (batting before pitching, skaters before goalies - see orderStatIdsByRole), each tagged with whether it's a rate stat (decimals, aggregated by averaging) and whether lower is better. Shared by the single-matchup Head-to-Head Scoreboard and the (timeframe-aware) Category Heatmap. The grouping is not cosmetic-only. Object.keys below returns integer-like keys in ascending NUMERIC order, which put hockey's goalie ids (0-11) ahead of every skater id, so the heatmap used to open with W/SO/GAA/SV% before a single skater category.
function scoredCategoriesInRange(startWeek, endWeek) {
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const avgSet = AVERAGE_STATS[sport] || new Set();
    const invSet = INVERSE_STATS[sport] || new Set();
    // Roto has no weekly spine to look through - a category "has data" if any team carries a season total for it (valuesByStat, landed in seasonCats by processCoreData).
    const hasData = id => AppState.isRotoLeague
        ? AppState.teamStats.some(t => t.seasonCats[id] !== undefined)
        : AppState.teamStats.some(t => {
            for (let w = startWeek; w <= endWeek; w++) if (t.weeklyCats[w] && t.weeklyCats[w][id] !== undefined) return true;
            return false;
        });
    const ids = Object.keys(statMap)
        .filter(id => AppState.scoredStatIds.has(id))
        .filter(hasData);
    // isSecondary tags which role group a category belongs to (pitching / goalies), so a consumer can mark where the two groups meet without re-deriving the split. The scoreboard uses it to draw the same thin rule between the groups that the recap image does.
    const secondaryIds = new Set(splitStatIdsByRole(sport, ids).secondary.map(String));
    return orderStatIdsByRole(sport, ids)
        .map(id => ({ id, name: statMap[id], isAvg: avgSet.has(id), inverse: invSet.has(id), isSecondary: secondaryIds.has(String(id)) }));
}

// A team's value in one category over a week range - summed for counting stats, averaged over the weeks actually played for rate stats (AVG, ERA,...). Matches renderCategoryGraph's own aggregation. undefined when the team has no data for it anywhere in the range.
function aggregateTeamCategory(team, catId, isAvg, startWeek, endWeek) {
    if (AppState.isRotoLeague) {
        // Full Season. The payload's season valuesByStat is the same number ESPN ranks on (seasonCats), and there are no weeks to aggregate. A "last N weeks" pill instead re-derives the category over ONLY that window's started-day components - rate stats from summed components, not averaged daily rates - so the heatmap and the windowed standings read the SAME sums. The startWeek/endWeek passed in are matchup-based and irrelevant here; roto windows are the race's week buckets, resolved by activeRotoWindow. computeRotoWindow is memoized, so this per-cell lookup is O(1). A team with no data in the window has no entry, so the cell renders blank.
        const sport = AppState.loadedSport;
        const bounds = activeRotoWindow(sport);
        if (!bounds) return team.seasonCats[catId];
        const win = computeRotoWindow(sport, bounds.start, bounds.end);
        return win ? win.catValuesByTeam.get(team.id)?.[catId] : team.seasonCats[catId];
    }
    let sum = 0, weeks = 0;
    for (let w = startWeek; w <= endWeek; w++) {
        if (team.weeklyCats[w] && team.weeklyCats[w][catId] !== undefined) { sum += team.weeklyCats[w][catId]; weeks++; }
    }
    if (weeks === 0) return undefined;
    return isAvg ? sum / weeks : sum;
}

// The heatmap's own machinery aimed at ONE team. It answers where that team ranks in every scored category over the current timeframe, best and worst three. Same aggregation and the same competition ranking the heatmap cells shade by, so My Team's profile and the heatmap row can never disagree. Exported rather than reimplemented, which is the whole point.
export function teamCategoryProfile(teamId) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const cats = scoredCategoriesInRange(start, end);
    const ranked = cats.map(cat => {
        const vals = AppState.teamStats
            .map(t => ({ id: t.id, v: aggregateTeamCategory(t, cat.id, cat.isAvg, start, end) }))
            .filter(x => x.v !== undefined);
        const mine = vals.find(x => x.id === teamId);
        if (!mine) return null;
        // Competition ranking, inverse-aware. Better values rank first, ties share a rank.
        const better = vals.filter(x => cat.inverse ? x.v < mine.v : x.v > mine.v).length;
        return { id: cat.id, name: cat.name, rank: better + 1, of: vals.length };
    }).filter(Boolean);
    // Owner's rule ( part 2 item 4). A category is BLEEDING when the team sits below the league's midpoint in it, winning when above. Expressed as a standing percentile rather than a rank so it means the same thing at any league size, so 4 teams bleed at #3 and #4, 5 teams bleed at #4 and #5 with #3 sitting exactly on the median and counting as neither. This replaces a best-three and worst-three cut, which was degenerate. With 14 categories over 4 teams a team usually holds enough firsts and lasts to fill both lists, so every chip read #1 or #4 and the middle of the table never appeared at all. The ranks themselves were right the whole time, and still are - they agree with the heatmap category by category.
    const pctOf = (r) => (r.of <= 1 ? 50 : ((r.of - r.rank) / (r.of - 1)) * 100);
    const scored = ranked.map(r => ({ ...r, pct: pctOf(r) }));
    const best = scored.filter(r => r.pct > 50).sort((a, b) => a.rank - b.rank);
    const worst = scored.filter(r => r.pct < 50).sort((a, b) => b.rank - a.rank);
    return { all: ranked, best, worst };
}

// Display value for a category cell - rate/average stats (AVG, ERA, WHIP,...) keep decimals, counting stats show as whole numbers. Matches renderCategoryGraph's own formatVal convention. An infinite rate is a real answer, not a glitch. A team with earned runs and no innings yet has an infinite ERA, and ESPN says so by sending the string "Infinity". numericStat turns that into a real number on the way in, and this renders it as the symbol rather than the word. The guard also means a value that is somehow still not a number prints a dash instead of throwing halfway through a render, which is what took the whole timeframe update down with it.
function formatCatValue(v) {
    if (v === undefined || v === null) return '-';
    const n = Number(v);
    if (!Number.isFinite(n)) return Number.isNaN(n) ? '-' : (n > 0 ? '∞' : '-∞');
    return (n % 1 !== 0) ? n.toFixed(3) : n;
}

function formatCatScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return Number.isNaN(n) ? '-' : (n > 0 ? '∞' : '-∞');
    return (n % 1 !== 0) ? n.toFixed(1) : n;
}

// Head-to-Head Scoreboard (single-matchup timeframe, category leagues) - replaces the old H2H Match Wins bars, which for one matchup were a useless all-or-nothing 1/0. Each matchup is a card: the two teams and their category-win score in the header, then a per-category breakdown of both teams' totals with the winning side of each category emphasized (inverse-aware, so a lower ERA wins). Filtered by AppState.visibleTeams ( reversed the old full-league convention): a card renders when AT LEAST ONE of its two teams is visible - filtering down to your own team keeps your own matchup (the opponent is the context that makes the card readable), and a card disappears only when both sides are hidden. renderScoreboardBox shows the empty state if that leaves no cards. Returns a plain grid of cards (no block header - the col-trends box's own h3 already reads "Matchup Scoreboard" via updateTrendsBoxChrome, so a second one here would be redundant). Stays builder-based (one function assembling all card markup from data) rather than being fused into renderScoreboardBox's layout/measurement code, on purpose. The planned premium win-odds column attaches an extra row to these same cards, and needs one seam to extend, not a rewrite of the ladder logic around it. EVERY scored category renders in every card, always (owner ruling, pass 2). There used to be a last-resort ladder step that kept only the tightest-margin categories and appended a "+N more in the heatmap below" line; a card that silently drops half the matchup is not a scoreboard. The height that step used to save is now absorbed by the grid choosing its column count and the cards filling the box - see renderScoreboardBox.
function buildH2HScoreboardHtml(week) {
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
        // At least one side visible, or the card is dropped.
        if (!AppState.visibleTeams.has(home.id) && !AppState.visibleTeams.has(away.id)) return '';
        const hScore = home.weeklyCatWins[week] || 0;
        const aScore = away.weeklyCatWins[week] || 0;

        const catRows = cats.map((c, i) => {
            const hv = home.weeklyCats[week]?.[c.id];
            const av = away.weeklyCats[week]?.[c.id];
            let homeWin = false, awayWin = false;
            if (hv !== undefined && av !== undefined && hv !== av) {
                (c.inverse ? hv < av : hv > av) ? homeWin = true : awayWin = true;
            } else if (hv !== undefined && av === undefined) homeWin = true;
            else if (av !== undefined && hv === undefined) awayWin = true;
            // Thin rule where the second role group starts (batting -> pitching, skaters -> goalies), the same marker the recap image draws between its two groups. Only when a primary-role row actually precedes it, so a single-role league carries no stray divider. The list itself stays ONE vertical column. Splitting these rows into two side-by-side blocks read as though one team owned a group of stats.
            const groupBreak = c.isSecondary && i > 0 && !cats[i - 1].isSecondary;
            return `
                ${groupBreak ? '<div class="h2h-cat-divider"></div>' : ''}
                <div class="h2h-cat-row">
                    <span class="h2h-cat-val h2h-cat-home${homeWin ? ' h2h-cat-win' : ''}">${formatCatValue(hv)}</span>
                    <span class="h2h-cat-name">${escapeHtml(c.name)}</span>
                    <span class="h2h-cat-val h2h-cat-away${awayWin ? ' h2h-cat-win' : ''}">${formatCatValue(av)}</span>
                </div>`;
        }).join('');

        // Both labels ship in the markup and CSS shows one (see.h2h-grid.h2h-abbrev). The ladder in renderScoreboardBox only toggles classes while it measures, so carrying both is what lets it try the abbreviation without rebuilding every card's HTML mid-search.
        const headTeam = (team, cls, winning) => `
            <div class="h2h-head-team ${cls}${winning ? ' h2h-head-lead' : ''}">
                <span class="h2h-dot" style="background:${AppState.teamColorMap[team.id]};"></span>
                <span class="h2h-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
                <span class="h2h-abbr" title="${escapeHtml(team.name)}">${escapeHtml(team.abbrev)}</span>
            </div>`;

        return `
            <div class="h2h-card">
                ${playoffSeriesLabelHtml(g)}
                <div class="h2h-head">
                    ${headTeam(home, 'h2h-head-home', hScore > aScore)}
                    <span class="h2h-head-score">${formatCatScore(hScore)}<span class="h2h-head-dash">-</span>${formatCatScore(aScore)}</span>
                    ${headTeam(away, 'h2h-head-away', aScore > hScore)}
                </div>
                <div class="h2h-cats">${catRows}</div>
            </div>`;
    }).join('');

    // No card survived the visibleTeams filter (every matchup fully hidden) - return empty so renderScoreboardBox shows the empty state instead of a bare grid.
    if (!cards) return '';
    return `<div class="h2h-grid">${cards}</div>`;
}

// The playoff series a matchup card is part of ( pass 3). During the playoffs a card says what it is FOR. Reuses data.js's tier classification straight off the schedule - WINNERS_BRACKET is the championship path, every other non-NONE playoffTierType is a consolation ladder - rather than re-deriving anything from ESPN. Empty string in the regular season, so a normal-week card carries no strip. Round names (semifinal/final) are deliberately not guessed here. The winners bracket spans several weeks and nothing in the game itself says which round without inferring bracket depth, so the tier label alone is what's defensible (see the pass-3 note).
function playoffSeriesLabelHtml(game) {
    const tier = game.playoffTierType;
    if (!tier || tier === 'NONE') return '';
    const isChamp = tier === 'WINNERS_BRACKET';
    return `<div class="h2h-series ${isChamp ? 'h2h-series-champ' : 'h2h-series-conso'}">${isChamp ? 'Championship' : 'Consolation'}</div>`;
}

// A points total, in the vocabulary a points league uses. Whole points stay whole, fractions keep one decimal. Deliberately NOT formatCatValue, which is built for category values and pads rate stats to three decimals - it rendered a 163.1 score as "163.100" and a scoreboard header wide enough to cost the grid two of its columns.
function formatPoints(v) {
    const n = Number(v) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// The Matchup Race (B51/): a points league's answer to the category breakdown. Where a category card lists who is winning each stat, a points matchup has one number per side, so the story worth telling is HOW it got there - two cumulative lines over the matchup's scoring periods, from the payload's own pointsByScoringPeriod, with the current margin called out underneath. VALIDATED against the 20-team points capture. Each side carries pointsByScoringPeriod as a { scoringPeriodId: pointsThatDay } map, and those days sum to that side's totalPoints exactly (163.1 and 159.7 on the first matchup of period 25). Days present on one side but not the other are unioned so both lines share an x-axis, and a missing day contributes 0 to that side rather than breaking the line. The chart is drawn in a normalized 0-100 viewBox with preserveAspectRatio="none" so it stretches to whatever cell the grid ladder hands it, and non-scaling-stroke keeps the lines the same weight however far it stretches. That is what lets a points card fill its space the way a category card does without the builder knowing anything about the final pixel size.
function buildMatchupRaceHtml(home, away, side) {
    const hPts = side.home.pointsByScoringPeriod || {};
    const aPts = side.away.pointsByScoringPeriod || {};
    const periods = [...new Set([...Object.keys(hPts), ...Object.keys(aPts)])]
        .map(Number).sort((a, b) => a - b);
    if (periods.length === 0) return '';

    let hRun = 0, aRun = 0;
    const hSeries = [], aSeries = [];
    periods.forEach(p => {
        hRun += statValue(hPts[p]) || 0;
        aRun += statValue(aPts[p]) || 0;
        hSeries.push(hRun);
        aSeries.push(aRun);
    });

    const peak = Math.max(...hSeries, ...aSeries, 1);
    const pointsFor = (series) => series
        .map((v, i) => `${periods.length === 1 ? 50 : (i / (periods.length - 1)) * 100},${100 - (v / peak) * 100}`)
        .join(' ');

    const lead = hRun >= aRun ? home : away;
    const margin = Math.abs(hRun - aRun);
    // "leads by" reads wrong for a dead heat, and a tied race is worth naming plainly. The label uses the abbreviation whichever way the header is currently showing names. This line sits under the chart with one line to work with, and the full name is on its title tooltip.
    const marginText = margin === 0
        ? 'Dead even'
        : `${lead.abbrev} leads by ${formatPoints(margin)}`;

    return `
        <div class="h2h-race">
            <svg class="h2h-race-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline points="${pointsFor(hSeries)}" fill="none" vector-effect="non-scaling-stroke"
                    stroke="${AppState.teamColorMap[home.id]}" stroke-width="2" />
                <polyline points="${pointsFor(aSeries)}" fill="none" vector-effect="non-scaling-stroke"
                    stroke="${AppState.teamColorMap[away.id]}" stroke-width="2" />
            </svg>
            <div class="h2h-race-margin" title="${escapeHtml(lead.name)}">${escapeHtml(marginText)}</div>
        </div>`;
}

// Points-league counterpart to buildH2HScoreboardHtml - same card shell, same grid, so the whole column-count/abbreviation/density ladder in renderScoreboardBox applies unchanged. Points leagues had NO scoreboard at all before this. At a single matchup they rendered the same Points bars the Rankings box was already showing, duplicated in both boxes and overflowing both.
function buildPointsScoreboardHtml(week) {
    const games = (AppState.apiData?.schedule || []).filter(g =>
        g.matchupPeriodId === week && g.home && g.away && g.home.teamId != null && g.away.teamId != null);
    if (games.length === 0) return '';

    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });

    const cards = games.map(g => {
        const home = teamById[g.home.teamId];
        const away = teamById[g.away.teamId];
        if (!home || !away) return '';
        // At least one side visible, or the card is dropped.
        if (!AppState.visibleTeams.has(home.id) && !AppState.visibleTeams.has(away.id)) return '';
        const hPts = statValue(g.home.totalPoints) || 0;
        const aPts = statValue(g.away.totalPoints) || 0;

        const headTeam = (team, cls, winning) => `
            <div class="h2h-head-team ${cls}${winning ? ' h2h-head-lead' : ''}">
                <span class="h2h-dot" style="background:${AppState.teamColorMap[team.id]};"></span>
                <span class="h2h-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
                <span class="h2h-abbr" title="${escapeHtml(team.name)}">${escapeHtml(team.abbrev)}</span>
            </div>`;

        // The card's own race, plus a pop-out button for it when there is a race to enlarge. A matchup with no day by day data draws no chart, so it gets no button either.
        const raceHtml = buildMatchupRaceHtml(home, away, g);
        const popoutBtn = raceHtml
            ? cardPopoutButtonHtml(
                registerCardVisual({ kind: 'race', home, away, side: g, title: `${home.name} vs ${away.name}` }),
                'Pop out this matchup race')
            : '';

        return `
            <div class="h2h-card">
                ${playoffSeriesLabelHtml(g)}
                ${popoutBtn}
                <div class="h2h-head">
                    ${headTeam(home, 'h2h-head-home', hPts > aPts)}
                    <span class="h2h-head-score">
                        <span class="h2h-score-full">${formatPoints(hPts)}<span class="h2h-head-dash">-</span>${formatPoints(aPts)}</span>
                        <span class="h2h-score-short">${Math.round(hPts)}<span class="h2h-head-dash">-</span>${Math.round(aPts)}</span>
                    </span>
                    ${headTeam(away, 'h2h-head-away', aPts > hPts)}
                </div>
                <div class="h2h-cats">${raceHtml}</div>
            </div>`;
    }).join('');

    // No card survived the visibleTeams filter - empty so renderScoreboardBox shows the empty state.
    if (!cards) return '';
    return `<div class="h2h-grid">${cards}</div>`;
}

// Per-card pop-out. The scoreboard's whole-box pop-out answers "show me the week"; this one answers "show me THIS matchup", which a 154px card in a 10-card grid can never do properly. Built as a CARD-LEVEL seam rather than a race-specific button. A card registers whatever visual it drew and gets back an id, the button carries that id, and openCardPopout dispatches on the visual's `kind` to a full-size renderer. Today the only kind is 'race' (the points matchup race). The deferred cats-card visuals (category race chart, swing meter, on-pace line) inherit the whole affordance by registering their own kind and adding one renderer branch - no new button, overlay, Esc wiring, or CSS.
let cardVisualSeq = 0;
const cardVisuals = new Map();

// Cleared at the top of every scoreboard render. The ids are positional, so stale entries from the previous week/timeframe would outlive the cards that own them and leak.
function resetCardVisuals() {
    cardVisuals.clear();
    cardVisualSeq = 0;
}

function registerCardVisual(visual) {
    const id = `cv${++cardVisualSeq}`;
    cardVisuals.set(id, visual);
    return id;
}

// The affordance is the same glyph and button class as the trends/heatmap pop-outs, so it reads as one family. It sits absolutely inside the card and only paints on hover/focus (see.h2h-card-popout) so it never competes with the score for the card's few pixels.
function cardPopoutButtonHtml(id, label) {
    return `<button type="button" class="h2h-card-popout trends-popout-btn" data-card-visual="${id}"
        title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">⛶</button>`;
}

// One matchup's race at full size. The card's normalized sparkline is redrawn as a real chart with axes, day labels, and a hover readout. Same padded-viewBox geometry as the Roto Race, including preserveAspectRatio="none" and the matching hover x-mapping (: the mapping assumes the viewBox stretches edge to edge, so the drawing has to actually stretch, and the cursor ratio has to divide by the PADDED width, not the element's).
function renderMatchupRaceDetail(container, visual) {
    const { home, away, side } = visual;
    const hPts = side.home.pointsByScoringPeriod || {};
    const aPts = side.away.pointsByScoringPeriod || {};
    const periods = [...new Set([...Object.keys(hPts), ...Object.keys(aPts)])].map(Number).sort((a, b) => a - b);
    if (periods.length === 0) {
        container.innerHTML = buildEmptyStateHtml('No day by day scoring for this matchup.');
        return;
    }

    let hRun = 0, aRun = 0;
    const hSeries = [], aSeries = [];
    periods.forEach(p => {
        hRun += statValue(hPts[p]) || 0;
        aRun += statValue(aPts[p]) || 0;
        hSeries.push(hRun);
        aSeries.push(aRun);
    });

    const svgWidth = 800, svgHeight = 350, padding = 45;
    const n = periods.length;
    const xAt = (i) => padding + (n <= 1 ? 0 : (i / (n - 1)) * (svgWidth - padding * 2));
    const maxPts = getNiceMax(Math.max(...hSeries, ...aSeries, 1));
    const yAt = (v) => svgHeight - padding - (v / maxPts) * (svgHeight - padding * 2);

    let svgStr = `<svg id="card-race-svg" width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none" style="display:block; cursor:crosshair; flex:1;">`;
    const formatTick = (val) => val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatTick(maxPts - (i / 4) * maxPts)}</text>`;
    }
    svgStr += `<line id="card-race-hover-line" y1="${padding}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="4,2" display="none" pointer-events="none" style="stroke:var(--chart-axis)" />`;

    // Days are numbered within the MATCHUP (1..n), not by ESPN's scoringPeriodId - the id is an internal season counter that means nothing to a reader looking at one week.
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil(n / maxLabels));
    periods.forEach((p, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return;
        svgStr += `<text x="${xAt(i)}" y="${svgHeight - 10}" font-size="12" text-anchor="middle" style="fill:var(--chart-axis)">Day ${i + 1}</text>`;
    });

    [[home, hSeries], [away, aSeries]].forEach(([team, series]) => {
        const color = AppState.teamColorMap[team.id];
        svgStr += `<polyline points="${series.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" />`;
        series.forEach((v, i) => { svgStr += `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="4" fill="${color}" />`; });
    });
    svgStr += `</svg>`;

    // The chart labels itself, with each side's colour, name and FINAL total in a legend row, so the reader never needs a sentence explaining what the two lines are.
    const legend = [[home, hRun], [away, aRun]].map(([team, total]) => `
        <span class="card-race-legend-item">
            <span class="card-race-swatch" style="background:${AppState.teamColorMap[team.id]};"></span>
            <span class="card-race-legend-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
            <strong>${formatPoints(total)}</strong>
        </span>`).join('');

    container.innerHTML = `
        <div style="display:flex; flex-direction:column; width:100%; height:100%; min-height:0;">
            <div class="card-race-legend">${legend}</div>
            <div style="position:relative; flex:1; min-height:0; display:flex;">
                ${svgStr}
                <div id="card-race-tooltip" style="position:fixed; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,0.3);"></div>
            </div>
        </div>`;

    const svgEl = document.getElementById('card-race-svg');
    const tooltipEl = document.getElementById('card-race-tooltip');
    const hoverLine = document.getElementById('card-race-hover-line');

    svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const padPx = (padding / svgWidth) * rect.width;
        const chartWidthPx = Math.max(1, rect.width - 2 * padPx);
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - padPx) / chartWidthPx));
        const i = n <= 1 ? 0 : Math.round(ratio * (n - 1));

        const lineX = xAt(i);
        hoverLine.setAttribute('x1', lineX);
        hoverLine.setAttribute('x2', lineX);
        hoverLine.setAttribute('display', 'block');

        // Best-first, so the readout doubles as "who was ahead on this day"..tt-rows lets layoutHoverTooltip reflow/clamp it exactly like every other hover in the app.
        const rows = [{ team: home, val: hSeries[i] }, { team: away, val: aSeries[i] }]
            .sort((a, b) => b.val - a.val)
            .map(r => `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="display:inline-block; width:12px; height:12px; background:${AppState.teamColorMap[r.team.id]}; border-radius:2px; flex:0 0 auto;"></span>
                <span style="width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(r.team.name)}</span>
                <span style="font-weight:bold; white-space:nowrap;">${formatPoints(r.val)}</span>
            </div>`).join('');
        tooltipEl.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">Day ${i + 1} of ${n}</div><div class="tt-rows">${rows}</div>`;
        tooltipEl.style.display = 'block';
        layoutHoverTooltip(tooltipEl, e.clientX, e.clientY);
    });

    svgEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
        hoverLine.setAttribute('display', 'none');
    });
}

// Which full-size renderer each registered visual kind uses. New card visuals add a line here.
const CARD_VISUAL_RENDERERS = { race: renderMatchupRaceDetail };

export function isCardPopoutOpen() {
    const overlay = document.getElementById('card-overlay');
    return !!(overlay && !overlay.hidden);
}

export function closeCardPopout() {
    const overlay = document.getElementById('card-overlay');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.getElementById('card-overlay-chart').innerHTML = '';
}

function openCardPopout(id) {
    const visual = cardVisuals.get(id);
    const overlay = document.getElementById('card-overlay');
    const chart = document.getElementById('card-overlay-chart');
    const renderer = visual && CARD_VISUAL_RENDERERS[visual.kind];
    if (!visual || !overlay || !chart || !renderer) return;
    document.getElementById('card-overlay-title').textContent = visual.title;
    overlay.hidden = false;
    // Render AFTER the overlay is visible. The chart sizes to its container, and a hidden container measures zero (the same reason the trends pop-out re-renders on open rather than CSS-scaling).
    renderer(chart, visual);
}

// Wires the overlay's own close button once. The card buttons are wired per render (the cards are rebuilt on every scoreboard render), in wireCardPopoutButtons below.
export function setupCardPopout() {
    const closeBtn = document.getElementById('card-popout-close');
    if (closeBtn) closeBtn.addEventListener('click', closeCardPopout);
}

function wireCardPopoutButtons(container) {
    container.querySelectorAll('.h2h-card-popout').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCardPopout(btn.dataset.cardVisual);
        });
    });
}

// Incremented on every renderScoreboardBox() call - superseded-render guard for its deferred ladder measurement, same pattern as leftColumnRenderId/catGraphRenderId above.
let scoreboardRenderId = 0;

// Renders the Matchup Scoreboard into the col-trends box and picks the arrangement that fills it. The grid FILLS the box by construction (height:100% with 1fr rows - see.h2h-grid), so there is no grey to measure away. The only open question is which arrangement lets every card show its full category list without clipping. That inverts the old ladder. It used to ask "does the content fit the box" and, when it didn't, degrade - compact, then drop categories behind a "+N more" line. Dropping categories is gone (owner ruling), and degrading was the wrong instinct anyway: at 2 matchups it went COMPACT while still leaving 43px of grey, because it could only ever shrink, never rearrange. So the search is over COLUMN COUNT first and density second. Fewer columns means wider cards but more rows of them, hence a taller grid; more columns means the reverse. The winner is the FEWEST columns that fit at the loosest density - biggest cards, most readable type. Normal density is tried across every column count before compact is tried at all, so type size is only sacrificed when no arrangement can hold the full list at full size. This is the same render-measure-iterate shrink-to-fit loop, just over a two-dimensional choice, and it re-runs on every render so a resize or a league switch re-decides instead of inheriting the previous answer. The fit test is per-CARD, not per-container..h2h-cats clips (overflow:hidden), so a card whose categories don't fit reports scrollHeight > clientHeight while the container itself still measures as full. Asking the container would always say "fits" once the grid fills it.
function renderScoreboardBox(container, week) {
    // Both league types render the same card shell into the same grid, so everything below - the column-count search, the abbreviation fallback, the density step, the scroll last resort - is shared. Only the card BODY differs, category rows for a category league, the matchup race for a points league (which has one number per side and no categories to list). Card visual ids are positional and rebuilt with the cards, so clear the registry first.
    resetCardVisuals();
    const html = AppState.isPointsLeague ? buildPointsScoreboardHtml(week) : buildH2HScoreboardHtml(week);
    if (!html) {
        // Empty either because the week has no matchups, or because every matchup was filtered out by the Data Filters - name the second case so the box reads like the rest of the tab.
        const anyVisible = AppState.teamStats.some(t => AppState.visibleTeams.has(t.id));
        container.innerHTML = buildEmptyStateHtml(anyVisible
            ? 'No matchups scheduled for this week.'
            : 'Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }
    container.innerHTML = `<div class="h2h-pager">${html}</div>`;
    attachDataTooltips(container);
    wireCardPopoutButtons(container);

    const pager = container.firstElementChild;
    const grid = pager.querySelector('.h2h-grid');
    const cards = [...grid.querySelectorAll('.h2h-card')];
    const cardCount = cards.length;
    const renderId = ++scoreboardRenderId;
    requestAnimationFrame(() => {
        if (renderId !== scoreboardRenderId) return;

        const apply = (cols, compact, label = 0) => {
            grid.style.setProperty('--h2h-cols', cols);
            grid.classList.toggle('h2h-compact', compact);
            grid.classList.toggle('h2h-abbrev', label >= 1);
            grid.classList.toggle('h2h-shortscore', label >= 2);
        };

        // Every category row fits its card's height, and the box isn't overflowing.
        const verticalOk = () =>
            container.scrollHeight <= container.clientHeight + 1 &&
            [...grid.querySelectorAll('.h2h-cats')].every(c => c.scrollHeight <= c.clientHeight + 1);

        // The card is still READABLE at this width. The visible team label shows in FULL (no ellipsis) and the value|name|value row doesn't clip. Squeezing more columns in otherwise collapses the header name toward zero pixels - a card that can't say who is playing has stopped being a scoreboard, whatever it does vertically. Measured on the elements, not a minimum card width.
        const horizontalOk = () =>
            [...grid.querySelectorAll('.h2h-card')].every(card => {
                const label = card.querySelector(
                    grid.classList.contains('h2h-abbrev') ? '.h2h-abbr' : '.h2h-name');
                const row = card.querySelector('.h2h-cat-row');
                return (!label || (label.clientWidth > 0 && label.scrollWidth <= label.clientWidth + 1))
                    && (!row || row.scrollWidth <= row.clientWidth + 1);
            });

        // One arrangement, tried at three header densities in order, full team names then abbreviations, then abbreviations with the score rounded to whole points. These are LABEL fallbacks INSIDE an arrangement rather than separate search axes - the cards keep the size the fit search earned them and only the header gives way, which is the owner's read that the names get too small past about three matchups. The score step exists because a points score is the widest thing in that header and does not shrink. At 154px cards "163.1-159.7" measured 88px and squeezed the team label to literally zero while the chart below it fit fine. Rounding to "163-160" gives the label its room back, and the exact totals are still on the margin line under the chart. A category score ("6.5-7.5") is already short, so this step is a no-op there.
        const HEADER_STEPS = [0, 1, 2]; // full name -> abbrev -> abbrev + rounded score
        const tryArrangement = (cols, compact) => {
            for (const label of HEADER_STEPS) {
                apply(cols, compact, label);
                if (horizontalOk() && verticalOk()) return true;
            }
            return false;
        };

        // How many of the cards are currently in the layout. Paging shows a slice; the fit search below asks "does a page of THIS size fit" by showing exactly that many.
        const showFirst = (n) => cards.forEach((c, i) => { c.style.display = i < n ? '' : 'none'; });

        const searchArrangement = (n) => {
            for (const compact of [false, true]) {
                for (let cols = 1; cols <= n; cols++) {
                    if (tryArrangement(cols, compact)) return true;
                }
            }
            return false;
        };

        // Best case, every card fits at full quality, so there is nothing to page.
        showFirst(cardCount);
        if (searchArrangement(cardCount)) {
            renderScoreboardPager(pager, cardCount, cardCount, cards);
            return;
        }

        // It doesn't fit.: PAGE rather than degrade to an internal scroll - the last scroller on this tab. Take the largest page that DOES fit at full quality, so the cards keep their size and their full category list and the arrows reach the rest. Counting down from the full set means the answer is the most cards the box can honestly hold, never fewer.
        for (let perPage = cardCount - 1; perPage >= 1; perPage--) {
            showFirst(perPage);
            if (searchArrangement(perPage)) {
                renderScoreboardPager(pager, perPage, cardCount, cards);
                return;
            }
        }

        // Even one card cannot satisfy both axes (an absurdly short box). Show it anyway at the tightest legible header rather than an empty box; one card per page is still paging, and still not a scrollbar.
        showFirst(1);
        apply(1, true, HEADER_STEPS[HEADER_STEPS.length - 1]);
        renderScoreboardPager(pager, 1, cardCount, cards);
    });
}

// Which page of matchup cards the scoreboard is showing. Module state, same lifetime rule as the category cycle. It survives a re-render so the arrows advance in place, and is clamped whenever the page count shrinks under it. Reset with the rest of the Rankings-box view state on a league switch.
let scoreboardPageIndex = 0;

// Paints the page slice and its chrome. The arrows are the Category Rankings arrows (.chrome-arrow) so the two pagers on this tab are one control, and they WRAP, so neither ever needs a disabled state. No indicator when everything fits - there is nothing to report.
function renderScoreboardPager(pager, perPage, cardCount, cards) {
    const pageCount = Math.max(1, Math.ceil(cardCount / perPage));
    if (scoreboardPageIndex >= pageCount) scoreboardPageIndex = 0;

    const paint = () => {
        const start = scoreboardPageIndex * perPage;
        cards.forEach((c, i) => { c.style.display = (i >= start && i < start + perPage) ? '' : 'none'; });
        const dots = pager.querySelector('.h2h-page-dots');
        if (dots) dots.textContent = `${scoreboardPageIndex + 1} / ${pageCount}`;
    };

    pager.querySelectorAll('.h2h-page-arrow, .h2h-page-dots').forEach(el => el.remove());
    pager.classList.toggle('h2h-paged', pageCount > 1);
    if (pageCount > 1) {
        pager.insertAdjacentHTML('beforeend', `
            <button type="button" class="chrome-arrow h2h-page-arrow h2h-page-prev" aria-label="Previous matchups">&#8249;</button>
            <button type="button" class="chrome-arrow h2h-page-arrow h2h-page-next" aria-label="More matchups">&#8250;</button>
            <div class="h2h-page-dots"></div>`);
        const advance = (d) => {
            scoreboardPageIndex = (scoreboardPageIndex + d + pageCount) % pageCount;
            paint();
        };
        pager.querySelector('.h2h-page-next').addEventListener('click', () => advance(1));
        pager.querySelector('.h2h-page-prev').addEventListener('click', () => advance(-1));
    }
    paint();
}

// Category Heatmap - a teams x scored-categories grid, each cell a team's value aggregated over the SELECTED TIMEFRAME (see aggregateTeamCategory), shaded by its rank among the visible teams in that category (green = leading the league, red = last, inverse-aware so a low ERA reads green). A permanent full-width band at every timeframe, and where the scoreboard's row-cap "+K more" line points (it always has every category). Respects the Teams legend. capRows false renders every team row uncapped - the pop-out overlay has the height for a full league and scrolls internally if it doesn't.
function renderDominanceHeatmap(container, { capRows = true } = {}) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    let teams = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));
    const cats = scoredCategoriesInRange(start, end);

    if (teams.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team above to compare.');
        return;
    }
    if (cats.length === 0) {
        container.innerHTML = buildEmptyStateHtml('No category data for this timeframe yet.');
        return;
    }

    // Aggregate every team's value in every category over the range, then rank per category by competition rank (ties share) among the teams that have a value - inverse categories rank the lowest value best.
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

    // Column sort. Rows order by the chosen category's RAW value - an inverse category sorts by value like any other, since the cell shading already says which end is good, and flipping the comparison as well would make one click read as two. A team with no value in that category has nothing to sort on, so it parks last in BOTH directions rather than winning an end by being undefined. The guard on valByCat also absorbs a sort left over from a league whose categories this one doesn't have.
    const sortCat = AppState.heatmapSortCat;
    const sortedVals = sortCat ? valByCat[sortCat] : null;
    if (sortedVals) {
        const dir = AppState.heatmapSortDir === 'asc' ? 1 : -1;
        teams = [...teams].sort((a, b) => {
            const av = sortedVals[a.id], bv = sortedVals[b.id];
            if (av === undefined && bv === undefined) return 0;
            if (av === undefined) return 1;
            if (bv === undefined) return -1;
            return (av - bv) * dir;
        });
    }

    const headCells = cats.map(c => {
        const isSorted = sortedVals && sortCat === c.id;
        // The arrow slot is rendered in EVERY header and only hidden when that column isn't the sort - omitting it outright let the label shift sideways the moment a column became sorted.
        const arrow = `<span class="dh-arrow${isSorted ? '' : ' dh-arrow-idle'}">${isSorted && AppState.heatmapSortDir === 'asc' ? '▲' : '▼'}</span>`;
        const tip = `${c.name}${c.inverse ? ' (lower is better)' : ''}. Click to sort.`;
        return `<th class="dh-sortable${isSorted ? ' dh-sorted' : ''}" data-cat="${escapeHtml(c.id)}" role="button" tabindex="0" title="${escapeHtml(tip)}">${escapeHtml(c.name)}${c.inverse ? ' <span class="dh-inv">&darr;</span>' : ''}${arrow}</th>`;
    }).join('');
    const bodyRows = teams.map(t => {
        const cells = cats.map(c => {
            const sortedCls = (sortedVals && sortCat === c.id) ? ' dh-sorted' : '';
            const v = valByCat[c.id][t.id];
            if (v === undefined) return `<td class="dh-empty${sortedCls}">-</td>`;
            const info = pctByCat[c.id][t.id];
            const tip = `${escapeHtml(t.name)} · ${escapeHtml(c.name)}: ${formatCatValue(v)} (#${info.rank} of ${info.total})`;
            return `<td class="dh-cell${sortedCls}" style="background:${percentileColor(info.pct)};" data-tooltip="${escapeHtml(tip)}">${formatCatValue(v)}</td>`;
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
    // Same affordances the player table's sortable headers use (pointer, hover colour, a title saying what a click does), plus Enter/Space so the sort is reachable without a mouse.
    container.querySelectorAll('th.dh-sortable').forEach(th => {
        const activate = () => cycleHeatmapSort(th.dataset.cat);
        th.addEventListener('click', activate);
        th.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
    });
    if (capRows) applyHeatmapRowCap(container);
    attachDataTooltips(container);
}

// Three-state cycle per column, descending then ascending, then back to the league's default team order. Re-renders through renderHeatmapBand so the same path serves the inline band and the pop-out overlay (the container node is the same one either way).
function cycleHeatmapSort(catId) {
    if (!catId) return;
    if (AppState.heatmapSortCat !== catId) {
        AppState.heatmapSortCat = catId;
        AppState.heatmapSortDir = 'desc';
    } else if (AppState.heatmapSortDir === 'desc') {
        AppState.heatmapSortDir = 'asc';
    } else {
        AppState.heatmapSortCat = null;
        AppState.heatmapSortDir = 'desc';
    }
    renderHeatmapBand();
}

// Past this many teams the band stops growing and scrolls internally instead. A 20-team league's heatmap was eating the vertical budget and squeezing the trends/rankings row above it, which is the same squeeze the trends pop-out was built to relieve.
const HEATMAP_MAX_VISIBLE_ROWS = 10;

// Caps the band at HEATMAP_MAX_VISIBLE_ROWS rows by measuring where the last visible row actually ends, rather than guessing a pixel height - row height moves with font size, padding and border-spacing, and an approximate cap would show 9 or 11 rows instead of 10. Applied SYNCHRONOUSLY, which is load-bearing. Every caller renders the two columns before the band (processCoreData, switchTab, handleTimeframeChange), and those columns defer their own compact/pie fitting to a requestAnimationFrame. Shrinking the band here, in the same synchronous pass, means those deferred measurements run against the already-reclaimed height and hand the freed space to the graphs above - no second render, and no chance of them fitting to a height the band is about to give back.
function applyHeatmapRowCap(container) {
    const wrap = container.querySelector('.dh-wrap');
    const table = wrap && wrap.querySelector('.dominance-heatmap');
    if (!wrap || !table || !table.tBodies[0]) return;
    const rows = table.tBodies[0].rows;
    if (rows.length <= HEATMAP_MAX_VISIBLE_ROWS) return;
    const lastVisible = rows[HEATMAP_MAX_VISIBLE_ROWS - 1];
    const capHeight = Math.ceil(lastVisible.getBoundingClientRect().bottom - table.getBoundingClientRect().top);
    if (capHeight <= 0) return;
    wrap.style.maxHeight = `${capHeight}px`;
    wrap.classList.add('dh-capped');
}

// intro is the italic explainer line above the bars - defaults to the "no trend line" framing this was originally written for (renderTrendGraph's points-league single-week fallback below), but renderStandings' single-matchup Category Wins branch reuses this same builder inside the Rankings box, where that framing doesn't apply (that box never shows a trend line) and the block header ("Category Wins - Matchup N") already says enough - pass intro: null there. Superseded-render guard for renderSingleWeekBars' deferred orientation measurement. Keyed BY CONTAINER rather than a single module counter, because two different boxes render single-week bars in the same tick, renderLeftColumn (the Rankings box) and then renderRightColumn (the trends box, for points leagues). A shared counter meant the second render cancelled the first one's measurement, so the Rankings box kept whatever orientation it was painted with and never got to flip - it looked like it had decided when it had been skipped.
const singleWeekRenderTokens = new WeakMap();

function renderSingleWeekBars(container, week, showCat, showMatch, { intro = 'Single-matchup timeframe selected, so this shows a direct comparison instead of a trend line.' } = {}) {
    const teams = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));
    if (teams.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    const rowsFor = (mapKey) =>
        teams.map(t => ({ id: t.id, name: t.name, val: t[mapKey][week] || 0, team: t })).sort((a, b) => b.val - a.val);

    const buildBlock = (title, mapKey, vertical) => {
        const rows = rowsFor(mapKey);
        if (rows.length === 0) return '';

        const minVal = Math.min(...rows.map(r => r.val));
        const maxVal = Math.max(...rows.map(r => r.val));
        const leaderVal = rows[0].val;
        const formatVal = (v) => v.toFixed(1);

        let html = `<div class="team-block">${buildBlockHeaderHtml(`${title} - Matchup ${week}`)}`;
        if (vertical) {
            const cols = rows.map((r, idx) => buildVerticalColumnHtml({
                name: r.name, val: r.val, color: AppState.teamColorMap[r.id],
                minVal, maxVal, leaderVal, isLeader: idx === 0, formatVal
            })).join('');
            html += `<div class="vcol-chart">${cols}</div>`;
        } else {
            // Wrapped so fitSingleWeekBars has one grid per block to drive, the same shape.std-bars gives the season standings.
            html += '<div class="swk-rows">';
            rows.forEach((r, idx) => {
                const split = splitByTier(r.team, week, week, w => r.team[mapKey][w]);
                html += buildComparisonBarRowHtml({
                    name: r.name, abbrev: r.team?.abbrev, val: r.val, color: AppState.teamColorMap[r.id],
                    minVal, maxVal, leaderVal, isLeader: idx === 0, split
                });
            });
            html += '</div>';
        }
        html += `</div>`;
        return html;
    };

    const specs = [];
    if (AppState.isPointsLeague) {
        // A points league's single-week view is the Points comparison only - a Match Wins bar for one game is a degenerate 1/0 per team. Points is driven by its own toggle, the toggle-cat slot relabeled "Points" for points leagues.
        if (showCat) specs.push(['Points', 'weeklyMatchWins']);
    } else {
        if (showCat) specs.push(['Category Wins', 'weeklyCatWins']);
        if (showMatch) specs.push(['Match Wins', 'weeklyMatchWins']);
    }

    const introHtml = intro
        ? `<div style="font-size: 11px; color: var(--text-subtle); margin-bottom: 10px; font-style: italic;">${intro}</div>`
        : '';

    const paint = (vertical) => {
        const content = specs.map(([t, k]) => buildBlock(t, k, vertical)).join('')
            || buildEmptyStateHtml('Enable at least one metric above to compare this matchup.');
        container.innerHTML = `
            <div class="single-week-wrap${vertical ? ' swk-vertical' : ''}" style="width: 100%;">
                ${introHtml}
                ${content}
            </div>
        `;
        attachDataTooltips(container);
    };

    // ADAPTIVE ORIENTATION. Columns are tried FIRST because they're the shape that fills both axes; rows are the fallback for when there are too many teams to give each column a usable width. Which side of that line a league falls on is MEASURED, not a hardcoded team count. The columns are laid out, then each one is asked whether its own VALUE LABEL fits the width it got. The value is the one thing that can't degrade - a team name truncates to an ellipsis and keeps its title tooltip (the same treatment.bar-title already gives long names), but a number that doesn't fit makes the column meaningless, so that is the flip test. Same render-measure-adjust shrink-to-fit loop, re-run on every render, so a resize or a legend toggle that changes the team count re-decides instead of staying stuck on the previous shape.
    paint(specs.length > 0);
    if (specs.length === 0) return;

    const token = {};
    singleWeekRenderTokens.set(container, token);
    requestAnimationFrame(() => {
        if (singleWeekRenderTokens.get(container) !== token) return;
        if (container.querySelector('.vcol-chart')) {
            const tooThin = [...container.querySelectorAll('.vcol')].some(col => {
                const label = col.querySelector('.vcol-value');
                return col.clientWidth < 1 || (label && label.scrollWidth > col.clientWidth);
            });
            if (!tooThin) return;
            paint(false);
        }
        // Rows, either by choice or because the columns were too thin. They get the same fit-all ladder the category blocks and the season standings use. At This Matchup a 20-team league is 20 rows in a box that never held them, and internal scrolling was the last place on Team Metrics that still happened.
        fitSingleWeekBars(container);
    });
}

// The fit-all ladder applied to the single-matchup ranking blocks, one column at the rows' natural height, two columns at that height, then a shrunk pitch, until every team is on screen. Shares the standings constants and the same row grid, so a 20-team This Matchup view reads exactly like the same league's season standings rather than inventing a third density.
function fitSingleWeekBars(container) {
    const blocks = [...container.querySelectorAll('.single-week-wrap .team-block')];
    const rowSets = blocks.map(b => [...b.querySelectorAll('.bar-row')]).filter(r => r.length);
    if (rowSets.length === 0) return;

    // Clear the previous fit so every measurement below is of the natural layout.
    blocks.forEach(b => {
        const wrap = b.querySelector('.swk-rows');
        if (!wrap) return;
        wrap.classList.remove('std-fit', 'std-2col', 'std-tiny');
        wrap.style.gridTemplateRows = '';
        wrap.style.removeProperty('--std-pitch');
        wrap.style.removeProperty('--std-row-gap');
    });

    const wraps = blocks.map(b => b.querySelector('.swk-rows')).filter(Boolean);
    if (wraps.length === 0) return;
    const counts = wraps.map(w => w.children.length);
    const naturalPitch = Math.max(...wraps.map((w, i) => w.getBoundingClientRect().height / counts[i]));

    // Everything in the container that is not a row, the intro line, each block's header and seam.
    let overhead = 0;
    const wrapEl = container.querySelector('.single-week-wrap');
    if (wrapEl) {
        [...wrapEl.children].forEach(child => {
            if (child.classList.contains('team-block')) {
                const h = child.querySelector('h4');
                const cs = getComputedStyle(child);
                overhead += (h ? h.getBoundingClientRect().height : 0)
                    + (parseFloat(cs.marginBottom) || 0) + (parseFloat(cs.paddingBottom) || 0)
                    + (parseFloat(cs.borderBottomWidth) || 0);
            } else {
                overhead += child.getBoundingClientRect().height;
            }
        });
    }

    const slotsFor = cols => counts.reduce((sum, n) => sum + Math.ceil(n / cols), 0);
    const gapsFor = cols => counts.reduce((sum, n) => sum + Math.max(0, Math.ceil(n / cols) - 1), 0);
    const availFor = (cols, gap) => container.clientHeight - overhead - STD_FIT_SLACK - gapsFor(cols) * gap;

    // This ladder publishes the league standard exactly as the season one does. It was the miss that made This Matchup show two densities. The box's other tab was matching a rhythm this path never took part in, so the same 20 teams came out 19px here and 21px there.
    const publishLadder = (g, p) => {
        if (container.clientHeight > 0 && g > 0 && p > 0) {
            leagueLadder = { gap: g, pitch: p, rows: counts.reduce((a, b) => a + b, 0) };
        }
    };
    const naturalGap = (() => {
        const wrap = wraps.find(w => w.children.length > 1);
        if (!wrap) return 0;
        const a = wrap.children[0].getBoundingClientRect();
        const b = wrap.children[1].getBoundingClientRect();
        return Math.max(0, Math.round(b.top - a.bottom));
    })();

    if (slotsFor(1) * naturalPitch <= availFor(1, rowGapFor(naturalPitch))) {
        publishLadder(naturalGap, Math.round(naturalPitch - naturalGap));
        return;
    }

    let cols = 2, pitch = naturalPitch, gap = rowGapFor(pitch);
    if (slotsFor(2) * naturalPitch > availFor(2, gap)) {
        pitch = Math.max(1, Math.floor(availFor(2, gap) / slotsFor(2)));
        if (rowGapFor(pitch) !== gap) {
            gap = rowGapFor(pitch);
            pitch = Math.max(1, Math.floor(availFor(2, gap) / slotsFor(2)));
        }
    }

    const apply = (p) => wraps.forEach((wrap, i) => {
        wrap.style.setProperty('--std-row-gap', `${gap}px`);
        wrap.style.setProperty('--std-pitch', `${p}px`);
        wrap.style.gridTemplateRows = `repeat(${Math.ceil(counts[i] / cols)}, ${p}px)`;
        wrap.classList.add('std-fit');
        wrap.classList.toggle('std-2col', cols > 1);
        wrap.classList.toggle('std-tiny', p < STD_PITCH_TINY);
    });
    apply(pitch);

    // Same bounded correction the standings fit makes, for the same reason. The estimate predates the grid, whose row boxes round differently.
    for (let guard = 0; guard < 6 && pitch > 1; guard++) {
        const over = container.scrollHeight - container.clientHeight;
        if (over <= 0) break;
        pitch = Math.max(1, pitch - Math.max(1, Math.ceil(over / slotsFor(cols))));
        apply(pitch);
    }
    // The corrective loop above can shave the pitch under the tiny line after the gap was chosen, so the published rhythm is re-read from the pitch that actually shipped rather than the one the arithmetic predicted. A 20px estimate corrected to 19px was still showing a 2px gap.
    if (rowGapFor(pitch) !== gap) {
        gap = rowGapFor(pitch);
        apply(pitch);
    }
    publishLadder(gap, pitch);
    sizeBarTitles(container);
}

function renderTrendGraph() {
    const container = document.getElementById('line-graph-container');
    container.innerHTML = '';

    const showCat = document.getElementById('toggle-cat').checked;
    const showMatch = document.getElementById('toggle-match').checked;
    const tfVal = AppState.timeframe;
    const { start: startWeek, end: endWeek } = getTimeframeBounds(tfVal, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);

    // A line "trend" needs at least two weeks to plot - a single-week timeframe would otherwise draw a single isolated dot. Category leagues never reach renderTrendGraph at a single matchup at all - renderRightColumn dispatches those straight to the Matchup Scoreboard instead (see renderScoreboardBox) - so the only way this branch is reached with startWeek === endWeek is a points league, which has no scoreboard equivalent (its weeklyMatchWins IS the real single-matchup stat: raw points scored) and keeps the single- week Points bar comparison it always has.
    if (startWeek === endWeek) {
        renderSingleWeekBars(container, startWeek, showCat, showMatch);
        return;
    }

    const svgWidth = 800;
    const svgHeight = 350;
    const padding = 45;

    // Two cumulative series, each with its own toggle, axis, line style, and vocabulary. Channel A is the SOLID line on the LEFT axis (toggle-cat); channel B the DASHED line on the RIGHT (toggle-match). Category leagues plot Cat Wins + Match Wins; points leagues plot Points (the cumulative point total that already rendered, now correctly labeled instead of wearing the Match Wins label) + Match Wins (the real 1/0.5/0 record from weeklyMatchResult, B52/). Both toggles now drive a real line in both league types, so neither is dead.
    const chanA = AppState.isPointsLeague
        ? { show: showCat, field: 'weeklyMatchWins', label: 'PTS' }
        : { show: showCat, field: 'weeklyCatWins', label: 'CAT' };
    const chanB = AppState.isPointsLeague
        ? { show: showMatch, field: 'weeklyMatchResult', label: 'WINS' }
        : { show: showMatch, field: 'weeklyMatchWins', label: 'WINS' };

    let maxA = 0, maxB = 0;

    AppState.teamStats.forEach(t => {
        let aSum = 0, bSum = 0;
        for (let w = startWeek; w <= endWeek; w++) {
            aSum += (t[chanA.field][w] || 0);
            bSum += (t[chanB.field][w] || 0);
            if (aSum > maxA) maxA = aSum;
            if (bSum > maxB) maxB = bSum;
        }
    });

    maxA = getNiceMax(maxA);
    maxB = getNiceMax(maxB);

    // preserveAspectRatio="none" makes the viewBox stretch edge-to-edge instead of letterboxing. The mousemove-to-week mapping below assumes the drawing fills the element's full width; without this the svg centres its 800-wide viewBox with "meet" scaling, so in the wide pop-out the cursor-to-week ratio is off by the letterbox margin and the last matchup is unreachable. The h2h race cards already do this for the same reason (see buildMatchupRaceHtml).
    let svgStr = `<svg id="trend-svg" width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none" style="display: block; cursor: crosshair; flex: 1;">`;
    const numWeeks = endWeek - startWeek;
    const formatTick = (val) => val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);

    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;

        if (chanA.show) {
            svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatTick(maxA - (i / 4) * maxA)}</text>`;
        }
        if (chanB.show) {
            svgStr += `<text x="${svgWidth - padding + 5}" y="${y + 4}" font-size="12" text-anchor="start" style="fill:var(--chart-axis)">${formatTick(maxB - (i / 4) * maxB)}</text>`;
        }
    }

    svgStr += `<line id="hover-line" y1="${padding}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="4,2" display="none" pointer-events="none" style="stroke:var(--chart-axis)" />`;

    if (numWeeks > 0 && AppState.regSeasonWeeks >= startWeek && AppState.regSeasonWeeks < endWeek) {
        const boundaryX = padding + ((AppState.regSeasonWeeks + 0.5 - startWeek) / numWeeks) * (svgWidth - padding * 2);
        svgStr += `<line x1="${boundaryX}" y1="${padding}" x2="${boundaryX}" y2="${svgHeight - padding}" stroke-width="1" stroke-dasharray="3,3" style="stroke:var(--chart-boundary)" />`;
        svgStr += `<text x="${boundaryX + 4}" y="${padding - 6}" font-size="10" text-anchor="start" style="fill:var(--text-faint)">Playoffs</text>`;
    }

    if (numWeeks > 0) {
        // A label per week works fine for a short range, but crams together and overlaps once "Regular Season + Playoffs" spans 20+ weeks - thin them out to a fixed max count, evenly spaced, always including the last week so the range's end is clear.
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

    // The line itself stays one consistent style throughout - the dashed "Playoffs" boundary marker above is enough to show where the playoffs start. The week's tier is still tracked in hoverData so the tooltip can tag (Playoff)/(Consolation) on hover.
    AppState.teamStats.forEach((t) => {
        if (!AppState.visibleTeams.has(t.id)) return;
        const color = AppState.teamColorMap[t.id];

        let aSum = 0, bSum = 0;
        let ptsA = [], ptsB = [];

        for (let w = startWeek; w <= endWeek; w++) {
            aSum += (t[chanA.field][w] || 0);
            bSum += (t[chanB.field][w] || 0);

            let x = padding + (numWeeks === 0 ? 0 : ((w - startWeek) / numWeeks) * (svgWidth - padding * 2));
            let yAVal = null, yBVal = null;
            const tier = getWeekTier(t, w);

            if (chanA.show) {
                yAVal = svgHeight - padding - (aSum / maxA) * (svgHeight - padding * 2);
                ptsA.push(`${x},${yAVal}`);
            }
            if (chanB.show) {
                yBVal = svgHeight - padding - (bSum / maxB) * (svgHeight - padding * 2);
                ptsB.push(`${x},${yBVal}`);
            }

            hoverData[w].push({ name: t.name, abbrev: t.abbrev, color, aSum, bSum, yA: yAVal, yB: yBVal, tier });
        }

        if (chanA.show) {
            svgStr += `<polyline points="${ptsA.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" />`;
            ptsA.forEach(p => { const [px, py] = p.split(','); svgStr += `<circle cx="${px}" cy="${py}" r="4" fill="${color}" />`; });
        }
        if (chanB.show) {
            svgStr += `<polyline points="${ptsB.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="6,4" />`;
            ptsB.forEach(p => { const [px, py] = p.split(','); svgStr += `<rect x="${px - 3}" y="${py - 3}" width="6" height="6" fill="${color}" />`; });
        }
    });

    svgStr += `</svg>`;

    Object.keys(hoverData).forEach(w => hoverData[w].sort((a, b) => b.bSum - a.bSum));

    container.innerHTML = `
        <div style="position:relative; width:100%; height:100%; display: flex;">
            ${svgStr}
            <div id="trend-tooltip" style="position:fixed; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:nowrap; box-shadow: 0 4px 12px rgba(0,0,0,0.3);"></div>
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
            if (d.yA !== null && Math.hypot(lineXPx - mouseX, (d.yA / svgHeight) * rect.height - mouseY) < 15) isNearPoint = true;
            if (d.yB !== null && Math.hypot(lineXPx - mouseX, (d.yB / svgHeight) * rect.height - mouseY) < 15) isNearPoint = true;
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

        // Header + one row per team, wrapped in.tt-rows so layoutHoverTooltip can reflow the rows into columns when a 20-team league would otherwise run past the chart and clip. data is already sorted best-first, so the reflow reads as a mini-standings.
        let rows = '';
        data.forEach(d => {
            const tierTag = d.tier === 'playoff' ? ' <span style="color:#ffb84d;font-size:9px;font-weight:normal;">(Playoff)</span>'
                : d.tier === 'consolation' ? ' <span style="color:#999;font-size:9px;font-weight:normal;">(Consolation)</span>'
                : '';
            let vals = [];
            if (chanA.show) vals.push(`${d.aSum.toFixed(1)} <span style="color:#aaa;font-weight:normal;font-size:10px;">${chanA.label}</span>`);
            if (chanB.show) vals.push(`${d.bSum.toFixed(1)} <span style="color:#aaa;font-weight:normal;font-size:10px;">${chanB.label}</span>`);
            rows += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="display:inline-block; width:12px; height:12px; background:${d.color}; border-radius:2px; flex:0 0 auto;"></span>
                <span style="width: 44px; overflow: hidden; text-overflow: ellipsis; font-weight: bold;">${escapeHtml(d.abbrev)}${tierTag}</span>
                <span style="font-weight:bold; white-space:nowrap;">${vals.join(' &nbsp;|&nbsp; ')}</span></div>`;
        });
        tooltipEl.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">Cumulative Stats Thru Matchup ${w}</div><div class="tt-rows">${rows}</div>`;
        tooltipEl.style.display = 'block';
        layoutHoverTooltip(tooltipEl, e.clientX, e.clientY);
    });

    svgEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
        hoverLine.setAttribute('display', 'none');
    });
}

// The Roto Race: one cumulative-roto-points line per team over the season, drawn in the trends box with the same visual language as renderTrendGraph (team colors, the Teams legend controlling which lines show, a hover column of standings at each week, and the pop-out). The series come from buildRotoRaceSeries (players.js), which owns the impure reconstruction; this function is purely presentation.
function renderRotoRaceGraph(container) {
    const sport = AppState.loadedSport;

    // Kick every source the race needs BEFORE deciding what to draw - buildRotoRaceSeries holds a loading state until they land, so starting them after that check would wait forever. All three are no-ops once loaded, in flight, or failed, and each one's completion re-renders this box through setWeeklyProgressHook. No timeframe pills exist for roto, so this is the only trigger path. The two roster harvests are the daily snapshots for started-accurate crediting and the draft + transaction log for the rostered fallback tier plus B66/.
    if (!weeklyDataFailed()) ensureWeeklyDataForRace(sport);
    ensureRosterSnapshotData(sport);
    ensureRosterTransactionData(sport);

    const race = buildRotoRaceSeries(sport);

    // One loading line held until the best expected tier is complete, then exactly one chart. Drawing each tier as it arrived repainted a visibly different race two or three times on a cold load; the ladder below it degrades on harvest FAILURE, never on latency.
    if (race.loading) {
        container.innerHTML = buildEmptyStateHtml('Building the Roto Race...');
        return;
    }
    if (race.weeks.length === 0) {
        container.innerHTML = buildEmptyStateHtml(weeklyDataFailed()
            ? "Couldn't load weekly player stats for the Roto Race. Re-fetch the league to try again."
            : 'No weekly player stats for the Roto Race yet.');
        return;
    }

    const svgWidth = 800, svgHeight = 350, padding = 45;
    const weeks = race.weeks;
    const numPoints = weeks.length;
    const xAt = (i) => padding + (numPoints <= 1 ? 0 : (i / (numPoints - 1)) * (svgWidth - padding * 2));

    // Axis scaled to every team's peak (not just the visible ones) so toggling a line in the legend never rescales the chart under the remaining lines.
    let maxPts = 0;
    race.seriesByTeam.forEach(series => series.forEach(v => { if (v > maxPts) maxPts = v; }));
    maxPts = getNiceMax(maxPts);
    const yAt = (v) => svgHeight - padding - (v / maxPts) * (svgHeight - padding * 2);

    // preserveAspectRatio="none" for the same reason as #trend-svg. The hover mapping assumes the viewBox fills the element edge-to-edge, so the drawing must actually stretch, not letterbox.
    let svgStr = `<svg id="roto-race-svg" width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none" style="display:block; cursor:crosshair; flex:1;">`;
    const formatTick = (val) => val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatTick(maxPts - (i / 4) * maxPts)}</text>`;
    }
    svgStr += `<line id="roto-hover-line" y1="${padding}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="4,2" display="none" pointer-events="none" style="stroke:var(--chart-axis)" />`;

    // Thin the x labels to at most ~10 so a full season's weeks don't crowd, always keeping the last.
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil(numPoints / maxLabels));
    weeks.forEach((wk, i) => {
        if (i % labelStep !== 0 && i !== numPoints - 1) return;
        svgStr += `<text x="${xAt(i)}" y="${svgHeight - 10}" font-size="12" text-anchor="middle" style="fill:var(--chart-axis)">${axisUnit().short}${wk}</text>`;
    });

    // hoverData[i] = the standings column at week i, sorted best-first for the tooltip.
    const hoverData = weeks.map(() => []);
    const colorFor = (id) => AppState.teamColorMap[id];
    race.teams.forEach(team => {
        const series = race.seriesByTeam.get(team.id) || [];
        series.forEach((pts, i) => hoverData[i].push({ id: team.id, name: team.name, pts, y: yAt(pts) }));
        if (!AppState.visibleTeams.has(team.id)) return; // legend interplay: hidden teams draw no line
        const color = colorFor(team.id);
        const pointsAttr = series.map((pts, i) => `${xAt(i)},${yAt(pts)}`).join(' ');
        svgStr += `<polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="2.5" />`;
        series.forEach((pts, i) => { svgStr += `<circle cx="${xAt(i)}" cy="${yAt(pts)}" r="4" fill="${color}" />`; });
    });
    hoverData.forEach(col => col.sort((a, b) => b.pts - a.pts));
    svgStr += `</svg>`;

    // The subtitle names the crediting source so the accuracy is never oversold, one line per rung of the fallback ladder (see buildRotoRaceSeries), the daily started lineups when we have them, the transaction roster history while those load, current rosters as the last resort.
    const subtitle = {
        started: "Started lineups from the league's daily rosters",
        rostered: 'Roster history from the league transactions',
        current: 'Based on current rosters'
    }[race.mode] || 'Based on current rosters';
    container.innerHTML = `
        <div style="display:flex; flex-direction:column; width:100%; height:100%;">
            <div class="roto-race-subtitle">${subtitle}</div>
            <div style="position:relative; flex:1; min-height:0; display:flex;">
                ${svgStr}
                <div id="roto-race-tooltip" style="position:fixed; display:none; background:var(--tooltip-bg); color:var(--tooltip-text); padding:12px; border-radius:6px; font-size:12px; z-index:1000; pointer-events:none; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,0.3);"></div>
            </div>
        </div>`;

    const svgEl = document.getElementById('roto-race-svg');
    const tooltipEl = document.getElementById('roto-race-tooltip');
    const hoverLine = document.getElementById('roto-hover-line');

    svgEl.addEventListener('mousemove', (e) => {
        const rect = svgEl.getBoundingClientRect();
        const padPx = (padding / svgWidth) * rect.width;
        const chartWidthPx = Math.max(1, rect.width - 2 * padPx);
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - padPx) / chartWidthPx));
        const i = numPoints <= 1 ? 0 : Math.round(ratio * (numPoints - 1));
        const col = hoverData[i];
        if (!col || col.length === 0) return;

        const lineX = xAt(i);
        hoverLine.setAttribute('x1', lineX);
        hoverLine.setAttribute('x2', lineX);
        hoverLine.setAttribute('display', 'block');

        // Same reflow-to-fit treatment as the Season Trends hover..tt-rows lets layoutHoverTooltip break a tall roster of teams into columns instead of clipping. col is already sorted best-first, so it reads as a mini-standings. Hidden teams are DROPPED from the readout now ( - the Data Filters apply here too), not listed with a dimmed swatch.
        let rows = '';
        col.filter(d => AppState.visibleTeams.has(d.id)).forEach(d => {
            rows += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="display:inline-block; width:12px; height:12px; background:${colorFor(d.id)}; border-radius:2px; flex:0 0 auto;"></span>
                <span style="width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(d.name)}</span>
                <span style="font-weight:bold; white-space:nowrap;">${d.pts % 1 !== 0 ? d.pts.toFixed(1) : d.pts}</span>
            </div>`;
        });
        tooltipEl.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">Roto Points Thru ${axisUnit().long} ${weeks[i]}</div><div class="tt-rows">${rows}</div>`;
        tooltipEl.style.display = 'block';
        layoutHoverTooltip(tooltipEl, e.clientX, e.clientY);
    });

    svgEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
        hoverLine.setAttribute('display', 'none');
    });
}

// Incremented on every renderCategoryGraph() call - superseded-render guard for its deferred compaction measurement, same pattern as leftColumnRenderId above.
let catGraphRenderId = 0;

// Which category the box is showing (, reworked in; the row-page half of this state was deleted in when the row pager went). Module state rather than AppState because it is pure view position. Keyed by STAT ID, not index. Every re-render rebuilds the block list from scratch (a timeframe click, a Data Filters toggle, the Advanced Stats toggle changing its length and order), and an index would quietly land on a different category each time. Only a league switch resets it - a new league's categories are a different list entirely.
let catViewedStatId = null;

// Which STANDINGS sections are currently drawn as a pie instead of bars, by section key. A Set rather than one flag because the sections flip INDEPENDENTLY - either, both, or neither. Same lifetime rule as the category cycle above. It survives every re-render (timeframe pills, Data Filters, a legend toggle) so a flipped section stays flipped, and only a league switch clears it.
const sectionPieViews = new Set();

export function resetRankingsViewState() {
    catViewedStatId = null;
    sectionPieViews.clear();
    scoreboardPageIndex = 0;
    // A new league has its own density, so its standard rhythm has to be measured afresh rather than inherited from whatever the last one could afford.
    leagueLadder = null;
}

// The canonical Category Rankings row pitch (B74's 28px, from the 6-team density the owner called good) lives in CSS now (.cat-capped.bar-row height) - made that the ONE pitch everywhere rather than a cap that only engaged when the flex-fill would stretch past it.

// One category's RACE, each team's cumulative value in that category, week by week, under its ranking bars. introduced it as an unlabeled sparkline to fill reclaimed space; makes it a real part of the block - a divider seams it to the bars, it labels ITSELF with data (the week span at the ends, each line's end value in its team colour), and it answers a hover with exact values. buildCategoryRaceSeries produces the data for BOTH league families off whichever source is honest: H2H: teamStats.weeklyCats, accumulated across the selected timeframe's weeks. Roto: rotoCategorySeries (players.js) - the same started-day component sums the roto standings and heatmap use, so a category's race and its bar agree by construction. Rate categories come back already derived from summed components at each week, never averaged. Returns null when there is nothing honest to draw, fewer than two weeks to race across (This Matchup), or a roto league on a fallback tier, where per-week shape would be wrong because those tiers count benched days ESPN never did. A block with no race just gives the height to its bars.
function buildCategoryRaceSeries(catId, teams, startWeek, endWeek) {
    if (AppState.isRotoLeague) {
        const sport = AppState.loadedSport;
        // At Current the week itself is the window, so the race runs across its DAYS. Same started-day crediting, same cumulative and rate handling, one bucket smaller.
        if (parseTimeframe(AppState.timeframe).window === 1) {
            const daily = rotoCategoryDailySeries(sport);
            if (daily) {
                const points = teams.map(t => ({
                    id: t.id,
                    name: t.name,
                    values: (daily.byTeam.get(t.id) || []).map(v => v[catId])
                })).filter(p => p.values.some(v => v !== undefined));
                if (points.length) return { weeks: daily.periods, points, dayAxis: true };
            }
            return null;
        }
        const series = rotoCategorySeries(sport);
        if (!series) return null;
        const points = teams.map(t => ({
            id: t.id,
            name: t.name,
            values: (series.byTeam.get(t.id) || []).map(v => v[catId])
        })).filter(p => p.values.some(v => v !== undefined));
        if (points.length === 0) return null;
        return { weeks: series.weeks, points };
    }

    // H2H at a single matchup has no race to draw. A CATEGORY league carries no per-day team values anywhere in the payload to build one from. pointsByScoringPeriod exists but is all zeros in every H2H_MOST_CATEGORIES capture checked, in both sports, because such a league scores categories rather than points, and cumulativeScore.scoreByStat is per MATCHUP, not per day ( audit). Building it would mean summing started players' daily lines the way roto does, which needs daily roster snapshots and pool-wide per-day player data - the memory the entry rules out. The block gives the height to its bars instead.
    if (endWeek - startWeek < 1) return null;
    const weeks = [];
    for (let w = startWeek; w <= endWeek; w++) weeks.push(w);
    const points = teams.map(t => {
        let run = 0;
        return {
            id: t.id,
            name: t.name,
            values: weeks.map(w => { run += (t.team.weeklyCats[w] && t.team.weeklyCats[w][catId]) || 0; return run; })
        };
    });
    return { weeks, points };
}

// Registry of the race data behind each rendered block, keyed by the block's render id, so the hover handler can answer with exact values without re-deriving anything. Cleared per render.
let catRaceSeq = 0;
const catRaceData = new Map();

// The race markup. The chart is a normalized 0-100 viewBox with preserveAspectRatio="none" so it stretches to whatever height the block hands it, and non-scaling-stroke keeps the line weight constant however far it stretches (B75's lesson). Every LABEL is HTML positioned over the plot, never SVG text. A non-uniformly stretched viewBox would squash text along with the drawing. Percentage positions survive the stretch exactly because they are resolved against the final box, not the viewBox. Inverse categories (ERA, GAA) are drawn as-is - the line is the real accumulated value, and the bars above already encode which end is good. Flipping the plot would make the same number read two different ways in one block.
function buildCategoryRaceHtml(series, isInverse) {
    if (!series) return '';
    const { weeks, points } = series;
    const n = weeks.length;
    // A day race counts its own days from one; a week race names the league's real unit. axisUnit is untouched either way. It names matchup and week axes, and Day is neither.
    const dayAxis = !!series.dayAxis;
    const flat = points.flatMap(p => p.values).filter(v => v !== undefined && Number.isFinite(v));
    if (flat.length === 0) return '';
    const peak = Math.max(...flat), floor = Math.min(...flat, 0);
    const span = (peak - floor) || 1;
    const yPct = (v) => 100 - ((v - floor) / span) * 100;
    const xPct = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;

    // The race indexes whatever the league's own timeline is, matchups in H2H and weeks in roto.
    const unit = axisUnit();
    const axisFrom = dayAxis ? 'Day 1' : `${unit.short}${weeks[0]}`;
    const axisTo = dayAxis ? `Day ${n}` : `${unit.short}${weeks[n - 1]}`;
    const id = `cr${++catRaceSeq}`;
    catRaceData.set(id, series);

    const polys = points.map(p => {
        const pts = p.values.map((v, i) => v === undefined ? null : `${xPct(i)},${yPct(v)}`).filter(Boolean).join(' ');
        return pts ? `<polyline points="${pts}" fill="none" vector-effect="non-scaling-stroke" stroke="${AppState.teamColorMap[p.id]}" stroke-width="1.5" opacity="0.9" />` : '';
    }).join('');

    // End-value labels, best-first so the leaders win any collision (the rAF pass in renderCategoryBlocks hides labels that would overlap, which is what keeps this readable as the team count climbs instead of turning into a stack of unreadable numbers).
    const ends = points
        .map(p => {
            const last = [...p.values].reverse().find(v => v !== undefined);
            return last === undefined ? null : { id: p.id, val: last };
        })
        .filter(Boolean)
        .sort((a, b) => isInverse ? a.val - b.val : b.val - a.val)
        .map(e => `<span class="cat-race-end" style="top:${yPct(e.val).toFixed(2)}%; color:${AppState.teamColorMap[e.id]};">${escapeHtml(formatCatValue(e.val))}</span>`)
        .join('');

    return `
        <div class="cat-race" data-race="${id}">
            <div class="cat-race-plot">
                <svg class="cat-race-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${polys}</svg>
                <span class="cat-race-hairline" hidden></span>
                ${ends}
            </div>
            <div class="cat-race-axis"><span>${axisFrom}</span><span>${axisTo}</span></div>
        </div>`;
}

// Hover on a category race shows teams and their exact cumulative values at the hovered week, best-first, through the shared layoutHoverTooltip so it reflows and clamps like every other hover.
function wireCategoryRaceHovers(container) {
    const tooltip = document.getElementById('cat-race-tooltip');
    if (!tooltip) return;
    container.querySelectorAll('.cat-race').forEach(raceEl => {
        const series = catRaceData.get(raceEl.dataset.race);
        const plot = raceEl.querySelector('.cat-race-plot');
        const hairline = raceEl.querySelector('.cat-race-hairline');
        if (!series || !plot) return;
        const inverse = raceEl.dataset.inverse === '1';

        plot.addEventListener('mousemove', (e) => {
            const rect = plot.getBoundingClientRect();
            const n = series.weeks.length;
            // The viewBox stretches edge to edge (preserveAspectRatio="none"), so the cursor ratio maps straight onto the index with no letterbox correction.
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            const i = n <= 1 ? 0 : Math.round(ratio * (n - 1));

            hairline.style.left = `${n === 1 ? 50 : (i / (n - 1)) * 100}%`;
            hairline.hidden = false;

            const rows = series.points
                .map(p => ({ name: p.name, id: p.id, val: p.values[i] }))
                .filter(r => r.val !== undefined && AppState.visibleTeams.has(r.id))
                .sort((a, b) => inverse ? a.val - b.val : b.val - a.val)
                .map(r => `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <span style="display:inline-block; width:12px; height:12px; background:${AppState.teamColorMap[r.id]}; border-radius:2px; flex:0 0 auto;"></span>
                    <span style="width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(r.name)}</span>
                    <span style="font-weight:bold; white-space:nowrap;">${escapeHtml(formatCatValue(r.val))}</span>
                </div>`).join('');
            if (!rows) return;

            tooltip.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">${escapeHtml(raceEl.dataset.cat || '')} thru ${series.dayAxis ? `Day ${i + 1}` : `${axisUnit().long} ${series.weeks[i]}`}</div><div class="tt-rows">${rows}</div>`;
            tooltip.style.display = 'block';
            layoutHoverTooltip(tooltip, e.clientX, e.clientY);
        });

        plot.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
            hairline.hidden = true;
        });
    });
}

// Row pitch (see.cat-capped.bar-row) and the smallest race worth drawing, in px. Both are read here to compute how much of a block actually fits before anything is painted, which is what lets the layout below decide by construction instead of measuring and then degrading.
const CAT_ROW_PITCH = 28;
// Race band heights, INCLUDING the race's own chrome (6px margin, 6px padding, 1px divider, and the ~13px week-span axis). Budgeting the band without its chrome is what made a "38px race" render a 12px plot, so the chrome was most of the allowance. Below CAT_RACE_MIN the band drops the axis (.cat-race-tight) and hands those 13px to the plot, because a readable line with the weeks in the hover beats an unreadable line with the weeks printed under it.
const CAT_RACE_MIN = 74;
const CAT_RACE_FLOOR = 33;
// The block header's full occupied height. The h4 measures 24px and carries a 10px bottom margin, and the margin is just as real to the layout as the text. Budgeting the 24 alone is what let the race collapse to 12px when the arithmetic said it had 72. The shared.section-head block, a 16px title line, 4px to the underline, the 2px underline, and the 6px margin beneath it. One number now, because both tabs use one header - the shrunk variant that used to tighten this margin is gone, since it moved the category tab's content off the standings tab's baseline.
const CAT_HEADER_H = 28;
const CAT_HEADER_SHRUNK_H = 28;
// The category pager's own chrome,.cat-paged's bottom padding, where the "n / m" indicator sits. The container's own padding is measured rather than assumed - see renderCategoryBlocks.
const CAT_PAGER_PAD = 12;
// NOTE on why there is no minimum-pitch constant here. Clamping the pitch UP to a readable floor overflows the very box the shrink exists to fit inside. A 9px floor against an 87px track for 10 rows overflowed the block by 3px and clipped the last team, which is the exact failure this rung exists to prevent. Fitting every team is the ruling, so the arithmetic wins. Under this pitch the row sheds everything that isn't the bar itself. The value label moves to the hover (the segments already carry it) and the type drops to the small size.
const CAT_PITCH_SHRUNK = 22;

// Lays the Category Rankings box out. Shared by the H2H (renderCategoryGraph) and roto (renderRotoCategoryGraph) renderers, which each hand over DATA - { id, name, inverse, rowsHtml, race } - rather than finished markup, because the layout decides how the rows are arranged. made the pager the whole interface. The box shows exactly ONE category at full width and height and the arrows cycle the league's entire list, wrapping, with a "n / m" indicator. There is no picker and no selection state. One category owning the whole box is also what makes the two-column row layout below possible. settled what happens when a category's teams do not fit. They always fit. The row pager is GONE - not a last resort, deleted - because "scroll down to see the rest of the league" is not an acceptable answer to "who is winning this category". Fitting every team now outranks the canonical 28px pitch that B76/B79/ held fixed, and the ladder yields in this order: 1. One column at the canonical pitch, with the race taking the leftover. 2. Two columns at the canonical pitch, rows filling DOWN then across so the ranking still reads top to bottom, race spanning the full width below. 3. Drop the RACE - the ranking is the content, the race is the enrichment. 4. Shrink the PITCH to whatever the box demands. Under CAT_PITCH_SHRUNK the row also sheds its value label to the hover and drops to the small type. Shrinking is measured and only ever the last rung. The pitch returns to canonical the moment the space allows, so nothing that fits comfortably today gets tighter.
function renderCategoryBlocks(container, blocks) {
    // clientHeight INCLUDES the container's own padding, which the block never gets to use. Measured rather than hardcoded so a padding change in CSS can't silently re-introduce the overflow this budget exists to prevent.
    const cs = getComputedStyle(container);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const height = Math.max(0, (container.clientHeight || 240) - pad);

    // The viewed category is remembered by STAT ID, not index. The Advanced Stats toggle changes the length and order of the list, and a timeframe click rebuilds it entirely, so an index would silently land on a different category. Falls back to the first when the remembered one is gone.
    let viewIndex = blocks.findIndex(b => b.id === catViewedStatId);
    if (viewIndex < 0) viewIndex = 0;
    catViewedStatId = blocks[viewIndex]?.id ?? null;
    const block = blocks[viewIndex];
    if (!block) return;

    const rowCount = block.rowsHtml.length;
    const hasRace = !!block.race;

    // The height budget has to include the pager's own chrome, or the block overruns the box by exactly that much. The "n / m" indicator sits in.cat-paged's bottom padding. Measured symptom of getting this wrong was a 149px box scrolling by exactly that padding.
    const chrome = blocks.length > 1 ? CAT_PAGER_PAD : 0;
    const avail = Math.max(0, height - chrome);
    // Rows per column and the height left over for the race, for a given column count at a given pitch. The gaps between rows are real height, exactly as they are on the standings side. Budgeting the pitch alone and then letting the grid add separation is how the box would overflow by the gap total. So the leftover the race bids against is net of them. The standard is whatever the standings tab is showing this league, so the two tabs read as one layout; the tiny pitch is the one thing allowed to undercut it, because at that density the gaps cost more height than the bars and the ruling is that every team fits.
    const standardGap = leagueLadder ? leagueLadder.gap : STD_NATURAL_GAP;
    const gapFor = pitch => (pitch < STD_PITCH_TINY ? Math.min(rowGapFor(pitch), standardGap) : standardGap);

    // When the standings tab is placing the SAME number of rows in this box - the single-matchup view, where both tabs rank the league once - the two are drawing the same picture and have no business drawing it at two heights. The category's canonical pitch becomes the standings' pitch for this render. Only ever downward. A pitch taller than canonical would be the category inventing a density of its own, and a pitch the standings could place is one this tab can place too.
    const twinLadder = !!leagueLadder && leagueLadder.rows === rowCount && leagueLadder.pitch > 0;
    const canonicalPitch = twinLadder ? Math.min(CAT_ROW_PITCH, leagueLadder.pitch) : CAT_ROW_PITCH;

    const fitFor = (cols, pitch = canonicalPitch) => {
        const perCol = Math.ceil(rowCount / cols);
        const gap = gapFor(pitch);
        const gaps = Math.max(0, perCol - 1) * gap;
        return { cols, perCol, pitch, gap, leftover: avail - (CAT_HEADER_H + perCol * pitch + gaps) };
    };

    // The ladder, in preference order. Fewest columns wins, and a full-height race beats a short one, but EVERY rung here shows every team - none of them drops or pages a single one. Columns are capped at 2: a third would leave each row about a third of 432px, not enough for a name plus a readable bar track, and shrinking the pitch keeps more of the row legible than that would.
    let chosen = null;
    const candidates = [
        { fit: fitFor(1), race: hasRace, need: CAT_RACE_MIN },
        { fit: fitFor(2), race: hasRace, need: CAT_RACE_MIN },
        { fit: fitFor(1), race: hasRace, need: CAT_RACE_FLOOR },
        { fit: fitFor(2), race: hasRace, need: CAT_RACE_FLOOR },
        { fit: fitFor(1), race: false, need: 0 },
        { fit: fitFor(2), race: false, need: 0 }
    ];
    for (const c of candidates) {
        if (c.race && !hasRace) continue;
        if (c.fit.leftover >= c.need) { chosen = c; break; }
    }

    let cols, rowsPerCol, showRace, pitch, gap;
    if (chosen) {
        cols = chosen.fit.cols;
        rowsPerCol = chosen.fit.perCol;
        showRace = chosen.race;
        pitch = chosen.fit.pitch;
        gap = chosen.fit.gap;
    } else {
        // Nothing holds every team at the canonical pitch, even in two columns with the race dropped. So the PITCH yields. Divide the real track height by the rows that must sit in it. The header also tightens here (.cat-shrunk), which is worth ~8px of track at exactly the moment 8px matters. The pitch is floored at 1px only to stay positive - it is deliberately NOT clamped up to a readable minimum, because a floor that exceeds the space overflows the box and clips the last team, which is the exact failure this whole rung exists to prevent.
        cols = 2;
        showRace = false;
        rowsPerCol = Math.ceil(rowCount / cols);
        const track = avail - CAT_HEADER_SHRUNK_H;
        const gaps = Math.max(0, rowsPerCol - 1);
        // Solve for the pitch with the gaps already paid for, then once more if that pitch turns out to be tiny enough for the cheaper 1px gap - the same two-step the standings fit uses, so both ladders land on the same density from the same height.
        gap = standardGap;
        pitch = Math.max(1, Math.floor((track - gaps * gap) / rowsPerCol));
        if (gapFor(pitch) !== gap) {
            gap = gapFor(pitch);
            pitch = Math.max(1, Math.floor((track - gaps * gap) / rowsPerCol));
        }
    }
    const gridRows = Math.ceil(rowCount / cols);

    catRaceData.clear();
    catRaceSeq = 0;

    // A band under CAT_RACE_MIN goes tight. The week-span axis is dropped so its 13px go to the plot.
    const tightRace = showRace && chosen && chosen.fit.leftover < CAT_RACE_MIN;
    const raceHtml = showRace ? buildCategoryRaceHtml(block.race, block.inverse) : '';
    const race = raceHtml
        ? raceHtml.replace('<div class="cat-race" ', `<div class="cat-race${tightRace ? ' cat-race-tight' : ''}" data-cat="${escapeHtml(block.name)}" data-inverse="${block.inverse ? 1 : 0}" `)
        : '';
    // cat-2col clamps the team name to its short form. At half width a 140px title would leave the bar track nothing to say (the full name stays on the row's title tooltip either way). cat-shrunk is the sub-canonical pitch, with tighter type, no value labels, tighter header.
    const shrunk = pitch < CAT_ROW_PITCH;
    const rowsCls = 'cat-rows' + (cols > 1 ? ' cat-2col' : '') + (pitch < CAT_PITCH_SHRUNK ? ' cat-rows-tiny' : '');
    const blockCls = 'team-block cat-block' + (shrunk ? ' cat-shrunk' : '');
    const pagerCls = 'cat-pager' + (blocks.length > 1 ? ' cat-paged' : '');
    container.innerHTML = `
        <div class="${pagerCls}">
            <div class="cat-fill cat-capped">
                <div class="${blockCls}">
                    ${block.header}
                    <div class="${rowsCls}" style="--cat-pitch:${pitch}px; --cat-row-gap:${gap}px; grid-template-rows: repeat(${gridRows}, ${pitch}px);">${block.rowsHtml.join('')}</div>
                    ${race}
                </div>
            </div>
            ${blocks.length > 1 ? `
                <button type="button" class="chrome-arrow cat-page-arrow cat-page-prev" aria-label="Previous category">&#8249;</button>
                <button type="button" class="chrome-arrow cat-page-arrow cat-page-next" aria-label="Next category">&#8250;</button>
                <div class="cat-page-dots">${viewIndex + 1} / ${blocks.length}</div>` : ''}
        </div>
        <div id="cat-race-tooltip" class="cat-race-tooltip"></div>`;

    attachDataTooltips(container);
    wireCategoryRaceHovers(container);

    // The arrows WRAP, so the control never dead-ends and never needs a disabled state.
    const advance = (deltaCat) => {
        const next = (viewIndex + deltaCat + blocks.length) % blocks.length;
        catViewedStatId = blocks[next].id;
        renderCategoryBlocks(container, blocks);
    };
    container.querySelector('.cat-page-next')?.addEventListener('click', () => advance(1));
    container.querySelector('.cat-page-prev')?.addEventListener('click', () => advance(-1));

    // One measured pass over the end labels. It only ever CLAMPS a label inside the plot or HIDES one that would collide - it never changes a pitch or a size, so it cannot move the box (the paging above already guaranteed the fit). Clamping matters at the extremes. The leader's line ends at 0% and the label is translateY(-50%), so half of it would sit above the plot and be clipped by the overflow:hidden that keeps the stretched viewBox in bounds.
    const renderId = ++catGraphRenderId;
    requestAnimationFrame(() => {
        if (renderId !== catGraphRenderId) return;
        // The label column is measured here too, so the category bars close the same grey channel the standings bars do. Cheap and width-only, so it cannot disturb the fit decided above. In the twin case the columns also hold open to whatever the standings tab measured, so the tracks END at one x across the two tabs and not just within each.
        sizeBarTitles(container, twinLadder ? { ...lastBarColumnWidths } : null);
        container.querySelectorAll('.cat-race-plot').forEach(plot => {
            const h = plot.getBoundingClientRect().height;
            if (!h) return;
            let lastTop = -Infinity;
            [...plot.querySelectorAll('.cat-race-end')].forEach(label => {
                const half = (label.offsetHeight || 9) / 2;
                const wanted = (parseFloat(label.style.top) / 100) * h;
                const top = Math.max(half, Math.min(h - half, wanted));
                const collides = Math.abs(top - lastTop) < 12;
                label.style.visibility = collides ? 'hidden' : '';
                if (collides) return;
                label.style.top = `${top}px`;
                lastTop = top;
            });
        });
    });
}

function renderCategoryGraph() {
    const container = document.getElementById('cat-graph-container');
    container.innerHTML = '';

    const sport = AppState.loadedSport;
    const avgStatsForSport = AVERAGE_STATS[sport] || new Set();
    const inverseStatsForSport = INVERSE_STATS[sport] || new Set();

    // Every category the league has, in role-grouped order - the pager cycles them one per screen. No selection state, because there is nothing to pick and nothing to restore.
    const selectedStats = categoryCycleList(sport);
    if (selectedStats.length === 0 || !AppState.teamStats.length) {
        container.innerHTML = buildEmptyStateHtml('No category data for this league yet.');
        return;
    }
    const visibleTeamsList = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));

    if (visibleTeamsList.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    const tfVal = AppState.timeframe;
    const { start: startWeek, end: endWeek } = getTimeframeBounds(tfVal, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);

    // One ranking block per category. renderCategoryBlocks shows exactly one of them at a time and the arrows cycle the rest, so every block is built at full width and height.
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

        // Just the stat name - the box is already titled "Category Rankings", so the suffix is redundant.
        const rowsHtml = [];

        const formatVal = (v) => (v % 1 !== 0) ? v.toFixed(3) : v;

        // The solid-bar decision is per BLOCK, not per team. If ANY team's tier component for this stat is negative, the whole block renders solid bars, so a +/- block never mixes shaded and solid rows. All-positive blocks (the counting-stat norm) keep their tier shading.
        const rows = teamVals.map((tv, idx) => ({
            tv, idx, split: splitByTier(tv.team, startWeek, endWeek, w => (tv.team.weeklyCats[w] ? tv.team.weeklyCats[w][stat.id] : 0))
        }));
        const blockHasNegative = rows.some(r => r.split.reg < 0 || r.split.playoff < 0 || r.split.consolation < 0);

        rows.forEach(({ tv, idx, split }) => {
            rowsHtml.push(buildComparisonBarRowHtml({
                name: tv.name, abbrev: tv.team?.abbrev, val: tv.val, color: AppState.teamColorMap[tv.id],
                minVal, maxVal, leaderVal, isLeader: idx === 0, split, formatVal, forceSolid: blockHasNegative
            }));
        });

        blocks.push({
            id: String(stat.id),
            name: stat.name,
            inverse: inverseStatsForSport.has(stat.id.toString()),
            header: buildBlockHeaderHtml(categoryHeaderLabel(sport, stat.id, stat.name)),
            rowsHtml,
            race: buildCategoryRaceSeries(stat.id, teamVals, startWeek, endWeek)
        });
    });

    renderCategoryBlocks(container, blocks);
}
