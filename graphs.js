import { AppState, AVERAGE_STATS, INVERSE_STATS, ESPN_STAT_MAPS } from './state.js';
import { getZoomedFillPct, getTimeframeBounds, getNiceMax, getWeekTier, tierColor, splitByTier, escapeHtml, attachDataTooltips, percentileColor, orderStatIdsByRole, splitStatIdsByRole, statValue, layoutHoverTooltip, categoryCycleList, categoryHeaderLabel, axisUnit } from './utils.js';
import { buildRotoRaceSeries, ensureWeeklyDataForRace, weeklyDataFailed, ensureRosterTransactionData, ensureRosterSnapshotData, activeRotoWindow, computeRotoWindow, rotoCategorySeries } from './players.js';

const TIER_LABELS = { reg: 'Regular Season', playoff: 'Playoffs', consolation: 'Consolation' };

// A section pie is drawn at this size and then scaled to its section's real box. The viewBox is fixed, so this placeholder only has to be sane, not right.
const SECTION_PIE_BASE_SIZE = 120;
// Breathing room between a pie and its section's edges, and the floor below which a pie is not worth drawing as anything but a token.
const SECTION_PIE_PAD = 12;
const SECTION_PIE_MIN_SIZE = 48;
// Headroom held back from the row budget: rows and borders resolve at sub-pixel sizes that round UP into the container's integer scrollHeight, so fitting exactly still produces a scrollbar.
const STD_FIT_SLACK = 6;
const STD_PITCH_TINY = 20;
// Clear space between stacked bars. Without it the tracks butt together at a shrunk pitch and a column reads as one striped block instead of one bar per team.
const STD_ROW_GAP = 2;

// One separation rule for every fitted bar ladder in the box, keyed off the PITCH rather than the tab, so the gap can only change by way of the density changing. The 1px floor is not cosmetic: at the tiny pitch the gaps cost more height than the bars do.
function rowGapFor(pitch) {
    return pitch < STD_PITCH_TINY ? 1 : STD_ROW_GAP;
}

// The league's standard separation between bars, published by the standings ladder and adopted by the category rows so the two tabs read as one layout. The standings publishes because it is always the denser view, drawing two sections of the league where the category tab draws one. { gap, pitch, rows }: the gap is adopted unconditionally, the pitch only when both tabs are placing the same number of rows. Null until a VISIBLE standings render measures one, since a hidden container has no height.
let leagueLadder = null;
// What an unfitted standings ladder shows, straight from `.bar-row-group { margin-bottom }`, for the case where the category tab is drawn before any standings tab has published. Keep in sync with that CSS rule.
const STD_NATURAL_GAP = 6;

// .bar-fill deliberately is not overflow:hidden, so a value label wider than its own bar spills past the bar's edge rather than being clipped. Below this width the label is not rendered inline at all, and the value moves to a hover tooltip instead.

// Renders a bar's fill as one segment per tier, each with its own tooltip. A single-tier value collapses to one segment carrying the full comparison-to-leader text.
function buildBarSegments(split, baseColor, overallTooltip, formatVal = (v) => v.toFixed(1), forceSolid = false) {
    const { reg, playoff, consolation, total } = split;
    const tierVals = [
        { val: reg, tier: 'reg' },
        { val: playoff, tier: 'playoff' },
        { val: consolation, tier: 'consolation' }
    ];
    const parts = tierVals.filter(p => p.val > 0);

    // A NEGATIVE tier component breaks the per-tier proportions: the total is the NET, so the surviving positive segments sum past 100% of a fill that does not clip, and a worse value rendered LONGER. Collapse to one solid segment coloured by the dominant positive tier, since fillPct already encodes the net correctly. forceSolid extends that to the whole block, so a block never mixes shaded and solid bars.
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

// THE section header for every block in the Rankings box, on both tabs. One helper and one class, so switching tabs moves neither the header nor the first row of content under it. nowrap and ellipsis are load-bearing: the category fit budget assumes this header is exactly one line tall, and a wrapped one would overrun the box by a row. `trailing` is anything pinned to the right edge, such as the standings sections' flip arrow.
function buildBlockHeaderHtml(title, trailing = '') {
    return `
        <div class="section-head">
            <h4 title="${escapeHtml(title)}">${escapeHtml(title)}</h4>
            ${trailing}
        </div>`;
}

// Shared "nothing to show" placeholder for a box emptied by the user's own filter selection rather than by a real data problem.
function buildEmptyStateHtml(message) {
    return `<div style="color: var(--text-subtle); text-align: center; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 14px;">${message}</div>`;
}

// One team's row in a bar-comparison block, shared by the single-matchup bars and Category Rankings, which differ only in how they compute the value and split.
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

// The row's team label. Both the full name and the league's own abbreviation ship in the markup and CSS picks one, so the two-column decision costs no rebuild, and the full name stays on the title tooltip either way.
function buildBarTitleHtml(name, abbrev) {
    const short = abbrev || name;
    return `<span class="bar-title" title="${escapeHtml(name)}"
        ><span class="bar-title-full">${escapeHtml(name)}</span
        ><span class="bar-title-abbr">${escapeHtml(short)}</span></span>`;
}

// One team's VERTICAL column in a single-matchup ranking. Rows are as tall as their own text and then stop, leaving a small league most of the box as grey, while columns fill both axes. A single-matchup window is one tier by definition, so a column is one solid fill.
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

// W-L-T record broken down by tier, which reads better than a decimal sum of 1/0.5/0 results. Category leagues store that result in weeklyMatchWins and points leagues in weeklyMatchResult, so the caller passes the right accessor.
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

// One team's row in the Rankings standings: a single bar scaled to the team's total across the range, split into one segment per bracket tier, regular season in the team's colour with playoffs darker and consolation lighter. Every segment carries its own tooltip.
function buildStandingsBarRowHtml({ teamId, name, abbrev, color, split, overallMax, recordByTier }) {
    const widthPct = overallMax > 0 ? (split.total / overallMax) * 100 : 0;
    const isChampion = teamId === AppState.championTeamId;

    // With records available a tier counts as present if any weeks were PLAYED in it, since an 0-2 playoff run is real information even at 0 wins. Without records, only tiers that contributed value can be sized.
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

    // Defensive: a team with no played weeks still renders one segment, so the row shows a nub with a tooltip instead of a blank track.
    if (parts.length === 0) parts = [{ tier: 'reg', val: 0, label: totalLabel }];

    // Segment widths are each tier's share of the bar's own total, floored so a played-but-zero tier stays a visible sliver, then re-normalized back to 100.
    const MIN_SEGMENT_PCT = 6;
    let widths = parts.map(p => split.total > 0 ? Math.max((p.val / split.total) * 100, MIN_SEGMENT_PCT) : 100 / parts.length);
    const widthSum = widths.reduce((sum, w) => sum + w, 0);
    widths = widths.map(w => (w / widthSum) * 100);

    const segmentsHtml = parts.map((p, i) => {
        const champTag = isChampion && p.tier === 'playoff' ? ' (Champion)' : '';
        const tip = `${TIER_LABELS[p.tier]}: ${p.label}${champTag}`;
        return `<div class="bar-segment" style="width:${widths[i]}%; background:${tierColor(p.tier, color)};" data-tooltip="${escapeHtml(tip)}"></div>`;
    }).join('');

    // The value sits in its own column at the END of the row rather than inside the fill, where a short bar had no room for it and the width guard dropped it on exactly the rows that most need reading.
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

// Incremented on every render, so a superseded deferred measurement can bail out.
let leftColumnRenderId = 0;

// The Rankings box shows one of two views, switched by its header tabs: Team Rankings (standings bars plus pies) or Category Rankings, which shows one category at a time with the arrows cycling the league's list.

export function renderLeftColumn() {
    const isCategory = AppState.rankingsBoxView === 'category';
    // Roto gets the same two views, built from ESPN's season standings instead of weekly matchups.
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

// Point the box's chrome at the active view: which tab reads as active, which container shows, and which of the two header controls occupies the slot beside the tabs.
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

    // A single-matchup window cannot make a W-L record, since every team is its own undecided 1/0 from one week. Show the ranking that IS real for a single week instead: categories won, or points scored in a points league. No pie arrow either, since one week has no season total to divide teams against.
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

    // Filtered by the Data Filters' visible teams, like every other box on this tab. All-hidden shows the shared empty state.
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

    // One standings section: a header plus one segmented bar per team, sorted by the section's total. valueKey picks the total to sort and size by, weekValue reads a team's per-week contribution, and a resultAt accessor renders a W-L-T record instead of a decimal sum.
    const buildSection = ({ key, header, valueKey, weekValue, resultAt, isLast }) => {
        const teams = [...leftData].sort((a, b) => b[valueKey] - a[valueKey]);
        const asPie = sectionPieViews.has(key);
        // Bars are built either way: they set the section's height even when the pie is what shows.
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

    // Points leagues get Match Wins and Points For, category leagues get H2H Match Wins and Category Wins. Both lead with a records-bearing section, so the shapes stay parallel.
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

    // The sections column FILLS the box so a section flipped to a pie has real space to expand into, while bars sections stay content-sized inside it.
    graph.innerHTML = `<div class="std-sections">${sectionsHtml}</div>`;

    attachDataTooltips(graph);
    if (sections.some(sec => sectionPieViews.has(sec.key))) attachPieTooltipLogic();
    wireSectionFlips(graph, renderStandings);

    // Deferred to the next animation frame: measured synchronously this reads stale or zero on the first call of a page load, as the results area flips from display:none. The render id guards against a newer render superseding this one before the frame fires.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;

        // Order matters. The fit runs FIRST because it decides which label each row shows, and sizing the column before that decision measures names that are about to become abbreviations. Pies last, since they inherit the fitted box.
        fitStandingsSections(graph);
        sizeBarTitles(graph);
        sizeSectionPies(graph);
        observeStandingsFit(graph);
    });
}

// Roto points arrive as halves whenever ESPN split a category tie, so they take one decimal when they have one and none when they do not.
function formatRotoPoints(v) {
    if (v === undefined || v === null) return '-';
    const num = Number(v);
    if (!Number.isFinite(num)) return '-';
    return (num % 1 !== 0) ? num.toFixed(1) : String(num);
}

// Roto Team Rankings: the classic roto table in house style, ordered by ESPN's own season total. Nothing is computed here beyond the sort.
function renderRotoStandings() {
    const graph = document.getElementById('left-graph-container');
    graph.innerHTML = '';

    // Full Season shows ESPN's official points verbatim. A lookback pill instead re-scores the categories over only that window's started-day components, through the same pure machinery the race uses.
    const sport = AppState.loadedSport;
    const bounds = activeRotoWindow(sport);
    const win = bounds ? computeRotoWindow(sport, bounds.start, bounds.end) : null;
    const pointsFor = t => win ? (win.pointsByTeam.get(t.id) || 0) : (t.rotoPoints || 0);

    // Filtered by the Data Filters' visible teams, like the H2H standings. All-hidden shows the shared empty state.
    const leftData = AppState.teamStats
        .filter(t => AppState.visibleTeams.has(t.id))
        .map(t => ({ id: t.id, name: t.name, rotoPoints: pointsFor(t), team: t }))
        .sort((a, b) => b.rotoPoints - a.rotoPoints);
    if (leftData.length === 0) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // Roto has ONE standings section, and it gets the same flip arrow the H2H sections do.
    const asPie = sectionPieViews.has('roto');
    const overallMax = Math.max(0, ...leftData.map(tv => tv.rotoPoints));
    const barsBody = leftData.map(tv => buildStandingsBarRowHtml({
        teamId: tv.id, name: tv.name, abbrev: tv.team?.abbrev, color: AppState.teamColorMap[tv.id],
        // Roto has no bracket, so the bar is a single regular-season segment rather than a tier split.
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

    // The same deferred pass the H2H standings run.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;
        fitStandingsSections(graph);
        sizeBarTitles(graph);
        sizeSectionPies(graph);
        observeStandingsFit(graph);
    });
}

// Roto Category Rankings: one block per category, teams ordered by the roto points THAT category awarded. Ordering by points rather than raw value is what matches ESPN's table without a separate inverse branch, since the points already encode the direction.
function renderRotoCategoryGraph() {
    const container = document.getElementById('cat-graph-container');
    container.innerHTML = '';

    // Every category the league has, in role-grouped order, cycled one per screen. There is no selection state to pick or restore.
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

    // Full Season reads ESPN's official per-category points and values, while a lookback pill re-scores over the window's started-day components. The period names the timeframe in the hover so the number is never oversold.
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
        // Just the stat name: the box is already titled Category Rankings, so a "Rankings" suffix here would be redundant.
        const rowsHtml = [];

        teamVals.forEach(tv => {
            const pts = tv.pts || 0;
            const fillPct = getZoomedFillPct(pts, minPts, maxPts);
            // Exactly one point reads "1 pt", and everything else including a half takes the plural.
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
        // Roto races too: the series walks the same started-day component sums the bars are scored from. On a fallback tier it returns null and the block has no race, which is the honest answer.
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

// One standings section: its header row with the flip arrow, plus whichever body it is currently showing. A pie section takes flex:1 so it fills the space it was given, while a bars section stays content-sized, which is what lets one section flip without moving the other.
function buildStandingsSectionHtml({ key, header, isLast, asPie, barsBody, pieBody }) {
    const seam = isLast
        ? 'border-bottom: none; margin-bottom: 0; padding-bottom: 0;'
        : 'border-bottom: 1px solid var(--border); margin-bottom: 4px; padding-bottom: 4px;';
    const label = asPie ? `Show ${header} as bars` : `Show ${header} as a pie chart`;
    // The BARS are always in the markup even when the pie is on screen, and the pie is laid over them. That is what makes flipping cost zero geometry: the section's height is always the height its bars need, so neither section moves by a pixel.
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

// A section's pie shows the SAME numbers its bars do, read off the same sorted rows and the same valueKey, so the two views can never disagree about who leads.
function buildSectionPieHtml(teams, valueKey) {
    const data = teams.map(t => ({
        id: t.id,
        name: t.name,
        val: t[valueKey] || 0,
        color: AppState.teamColorMap[t.id]
    }));
    const pie = createPieChart(data, '', SECTION_PIE_BASE_SIZE);
    // Every team at zero, so createPieChart draws nothing rather than a fake full circle. Say so instead of leaving the section blank.
    if (!pie) return buildEmptyStateHtml('No totals to split for this timeframe yet.');
    return `<div class="std-pie">${pie}</div>`;
}

// Sizes every pie in the box once, after layout, under two rules: flipping moves nothing, and a pie never needs scrolling. They only disagree when the bars overflow, which is exactly the case where the second should win, since nothing is moving that the reader could have seen anyway.
function sizeSectionPies(graph) {
    const pieSections = [...graph.querySelectorAll('.std-section.is-pie')];
    if (pieSections.length === 0) return;
    // A couple of px per section of slack, because the header's line box and the seam borders round in ways that put two exactly-computed caps a hair over the box.
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
        // Everything in the section that is not the body: its header plus the seam to the next section. Built up from those parts rather than subtracted from the section's own height, because a shrinkable section measures smaller than its content and the subtraction went negative.
        const headCs = section.querySelector('.section-head');
        const secCs = getComputedStyle(section);
        const seam = (parseFloat(secCs.marginBottom) || 0)
            + (parseFloat(secCs.paddingBottom) || 0)
            + (parseFloat(secCs.borderBottomWidth) || 0);
        const overhead = (headCs ? headCs.getBoundingClientRect().height : 0) + seam;
        const cap = Math.max(SECTION_PIE_MIN_SIZE + SECTION_PIE_PAD, share - overhead);

        // Cap ONLY when the bars actually overrun their share. Applying it unconditionally shaved a few px off sections that already fit, since a rect excludes the last row's trailing margin.
        body.style.maxHeight = natural > cap ? `${Math.round(cap)}px` : '';

        // Measured after the cap decision, so it reflects the box the pie actually got.
        const holderBox = holder.getBoundingClientRect();
        const size = Math.max(SECTION_PIE_MIN_SIZE, Math.floor(Math.min(holderBox.width, holderBox.height)) - SECTION_PIE_PAD);
        svg.style.width = `${size}px`;
        svg.style.height = `${size}px`;
    });

    // These caps land after the fit already made its corrective pass, so its arithmetic could not have accounted for them. Trim once more if the box still overruns.
    for (let guard = 0; guard < 6; guard++) {
        // Converge to ZERO, not to close enough: scrollHeight and clientHeight are integers, so a single leftover pixel is a real scrollbar.
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

// Fits EVERY standings row into the box: one column at the natural height, then two columns, then a shrunk pitch, until every team is on screen. The pitch is shared across sections so the two stay visually parallel, and content-sized sections are what stop one section's rows painting over the next.
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

    // Everything in the box that is not a row: each section's header and the seam to the next.
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
    // The inter-row gaps are real height: one fewer than the rows in each section's tallest column.
    const gapsFor = cols => barsEls.reduce((sum, _, i) => sum + Math.max(0, Math.ceil(rowCounts[i] / cols) - 1), 0);
    const availFor = (cols, gap) => graph.clientHeight - overhead - STD_FIT_SLACK - gapsFor(cols) * gap;

    // The rhythm this render actually shows, published for the category rows to match. In the unfitted case it is the row group's own margin, which is why it is measured off two adjacent rows rather than assumed.
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

    // Rung 1: it already fits in one column, so leave the rows exactly as they render naturally.
    if (slotsFor(1) * naturalPitch <= availFor(1, rowGapFor(naturalPitch))) {
        publishLadder(naturalGap, Math.round(naturalPitch - naturalGap));
        return;
    }

    let cols = 2;
    let pitch = naturalPitch;
    let gap = rowGapFor(pitch);
    if (slotsFor(2) * naturalPitch > availFor(2, gap)) {
        pitch = Math.max(1, Math.floor(availFor(2, gap) / slotsFor(2)));
        // Shrinking can drop the pitch into tiny territory, where the gap costs 1px instead of 2. Re-solve once with the cheaper gap so those pixels go back to the rows.
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

    // One bounded corrective pass: the arithmetic works from a pitch measured before the grid existed, and the grid's own row boxes round differently.
    for (let guard = 0; guard < 6 && pitch > 1; guard++) {
        // Same rule as the pie trim below: zero, not close enough.
        const over = graph.scrollHeight - graph.clientHeight;
        if (over <= 0) break;
        pitch = Math.max(1, pitch - Math.max(1, Math.ceil(over / slotsFor(cols))));
        apply(pitch);
    }
    // The correction can cross the tiny line after the gap was picked, so re-read it off the pitch that actually shipped.
    if (rowGapFor(pitch) !== gap) {
        gap = rowGapFor(pitch);
        apply(pitch);
    }
    publishLadder(gap, pitch);
}

// Re-runs the fit whenever the box changes size, so the layout is never left holding a measurement that was true once. Observing the CONTAINER is what makes this safe from feedback: the fit only changes the height of descendants, and it clears its own previous output before measuring.
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

// Sizes the team-label column to the LONGEST label actually on screen rather than a fixed generous width, so a box showing abbreviations hands the reclaimed width to the tracks.
const BAR_TITLE_MIN = 34;
const BAR_TITLE_MAX = 140;
const BAR_TITLE_PAD = 8;
const BAR_VALUE_MAX = 90;
const BAR_VALUE_PAD = 4;
// The label and value column widths the last bar view measured, so the other Rankings tab can hold its own columns open to at least the same width when both are drawing the same league.
const lastBarColumnWidths = { title: 0, value: 0 };

// floorWidths lets a caller hold a column open to a width another view measured, so the tracks end at one x across the two tabs and not only within each.
function sizeBarTitles(container, floorWidths = null) {
    const rows = [...container.querySelectorAll('.bar-row')];
    if (rows.length === 0) return;

    let widestLabel = 0;
    container.querySelectorAll('.bar-title').forEach(title => {
        // Whichever of the two labels CSS is currently showing, full name or abbreviation.
        [...title.children].forEach(span => {
            if (span.offsetParent === null && span.offsetWidth === 0) return;
            if (getComputedStyle(span).display === 'none') return;
            widestLabel = Math.max(widestLabel, span.offsetWidth);
        });
    });
    if (widestLabel) {
        let w = Math.max(BAR_TITLE_MIN, Math.min(BAR_TITLE_MAX, Math.ceil(widestLabel) + BAR_TITLE_PAD));
        // Only a view measuring purely its own content publishes: a follower writing its floored width back would ratchet the column wider and never let it narrow again.
        if (!floorWidths) lastBarColumnWidths.title = w;
        else w = Math.max(w, floorWidths.title || 0);
        container.style.setProperty('--bar-title-w', `${w}px`);
    }

    // The value column is measured for the same reason the label column is. Content-sized, a long value string and a short one reserved different widths, so the flexible track beside them ended at a different x on every row.
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

// Wires the per-section flip arrows, re-attached on every render because the sections are rebuilt.
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

// Pie slices get a hover-dim effect on top of the tooltip positioning attachDataTooltips already provides. This only adds the opacity change.
function attachPieTooltipLogic() {
    const container = document.getElementById('left-graph-container');
    if (!container) return;

    container.querySelectorAll('.pie-slice').forEach(slice => {
        slice.addEventListener('mouseenter', () => { slice.style.opacity = '0.7'; });
        slice.addEventListener('mouseleave', () => { slice.style.opacity = '1'; });
    });
}

// Season Trends and Category Rankings are separate always-visible panels rather than one dropdown-switched view, so both render every time.
function updateTrendToggleLabels() {
    const catLabel = document.getElementById('toggle-cat')?.parentElement;
    if (catLabel && catLabel.lastChild) catLabel.lastChild.textContent = AppState.isPointsLeague ? 'Points' : 'Cat Wins';
}

export function renderRightColumn() {
    const container = document.getElementById('line-graph-container');
    container.style.display = 'flex';
    updateTrendToggleLabels();

    if (AppState.isRotoLeague) {
        // The Roto Race: the standings reconstructed over the season from each team's roster.
        const title = document.getElementById('trends-box-title');
        const tooltip = document.getElementById('trends-box-tooltip');
        if (title) title.textContent = 'Roto Race';
        if (tooltip) tooltip.textContent = "Each team's cumulative roto points week by week, rebuilt from its current roster. ESPN keeps no roster history, so trades slightly rewrite the past.";
        renderRotoRaceGraph(container);
        return;
    }

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    // Points leagues get the scoreboard too.
    const isScoreboard = startWeek === endWeek;
    updateTrendsBoxChrome(isScoreboard);

    if (isScoreboard) {
        renderScoreboardBox(container, startWeek);
    } else {
        renderTrendGraph();
    }
}

// Swaps the trends box's title and tooltip between its two roles, using a span inside the existing markup rather than a second header, so nothing shifts when the content changes.
function updateTrendsBoxChrome(isScoreboard) {
    const title = document.getElementById('trends-box-title');
    const tooltip = document.getElementById('trends-box-tooltip');
    if (title) title.textContent = isScoreboard ? 'Matchup Scoreboard' : 'Season Trends';
    if (!tooltip) return;
    // Roto never reaches here: it sets its own title and returns earlier, so this only covers the matchup box's two roles.
    tooltip.textContent = isScoreboard
        ? "This week's matchups, category by category. The winning side of each is bolded. Switch to a wider timeframe for the season trend line."
        : `${AppState.isPointsLeague ? 'Points' : 'Cat Wins'} and Match Wins using the selected timeframe. The dashed line marks when playoffs started. Hover any point to get a breakdown.`;
}

// The Category Heatmap is a permanent full-width band below the two columns, visible at every timeframe and timeframe-aware.
// The team's best and bleeding categories, for the My Team summary. A category is bleeding when the team sits below the league's midpoint in it and winning when above, expressed as a standing percentile rather than a rank so it means the same thing at any league size. Competition ranking, inverse-aware, so it agrees with the heatmap category by category.
export function teamCategoryProfile(teamId) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const cats = scoredCategoriesInRange(start, end);
    const ranked = cats.map(cat => {
        const vals = AppState.teamStats
            .map(t => ({ id: t.id, v: aggregateTeamCategory(t, cat.id, cat.isAvg, start, end) }))
            .filter(x => x.v !== undefined);
        const mine = vals.find(x => x.id === teamId);
        if (!mine) return null;
        const better = vals.filter(x => cat.inverse ? x.v < mine.v : x.v > mine.v).length;
        return { id: cat.id, name: cat.name, rank: better + 1, of: vals.length };
    }).filter(Boolean);
    const pctOf = (r) => (r.of <= 1 ? 50 : ((r.of - r.rank) / (r.of - 1)) * 100);
    const scored = ranked.map(r => ({ ...r, pct: pctOf(r) }));
    const best = scored.filter(r => r.pct > 50).sort((a, b) => a.rank - b.rank);
    const worst = scored.filter(r => r.pct < 50).sort((a, b) => b.rank - a.rank);
    return { all: ranked, best, worst };
}

export function renderHeatmapBand() {
    const container = document.getElementById('heatmap-graph-container');
    if (!container) return;
    // Roto reaches the same renderer, since its season totals feed the same shading, so the row cap, column sorting and pop-out all work with no roto-specific handling.
    renderDominanceHeatmap(container, { capRows: !isHeatmapPoppedOut() });
}

// True while the heatmap band is docked inside its pop-out overlay, which moves the real container node in and out.
function isHeatmapPoppedOut() {
    const slot = document.getElementById('heatmap-overlay-chart');
    const container = document.getElementById('heatmap-graph-container');
    return !!(slot && container && slot.contains(container));
}

// The league's scored categories that have data anywhere in the range, role-grouped, each tagged with whether it is a rate stat and whether lower is better.
function scoredCategoriesInRange(startWeek, endWeek) {
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const avgSet = AVERAGE_STATS[sport] || new Set();
    const invSet = INVERSE_STATS[sport] || new Set();
    // Roto has no weekly spine to look through, so a category has data when any team carries a season total for it.
    const hasData = id => AppState.isRotoLeague
        ? AppState.teamStats.some(t => t.seasonCats[id] !== undefined)
        : AppState.teamStats.some(t => {
            for (let w = startWeek; w <= endWeek; w++) if (t.weeklyCats[w] && t.weeklyCats[w][id] !== undefined) return true;
            return false;
        });
    const ids = Object.keys(statMap)
        .filter(id => AppState.scoredStatIds.has(id))
        .filter(hasData);
    // isSecondary tags which role group a category belongs to, so a consumer can mark where the two groups meet without re-deriving the split.
    const secondaryIds = new Set(splitStatIdsByRole(sport, ids).secondary.map(String));
    return orderStatIdsByRole(sport, ids)
        .map(id => ({ id, name: statMap[id], isAvg: avgSet.has(id), inverse: invSet.has(id), isSecondary: secondaryIds.has(String(id)) }));
}

// A team's value in one category over a week range: summed for counting stats, averaged over the weeks actually played for rate stats.
function aggregateTeamCategory(team, catId, isAvg, startWeek, endWeek) {
    if (AppState.isRotoLeague) {
        // Full Season reads the payload's season values, which are the same numbers ESPN ranks on, and there are no weeks to aggregate.
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

// Display value for a category cell: rate stats keep decimals, counting stats show as whole numbers.
function formatCatValue(v) {
    if (v === undefined || v === null) return '-';
    return (v % 1 !== 0) ? v.toFixed(3) : v;
}

function formatCatScore(v) {
    return (v % 1 !== 0) ? v.toFixed(1) : v;
}

// Head-to-head scoreboard for the single-matchup timeframe, replacing bars that for one matchup were a useless all-or-nothing 1/0.
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
        // At least one side has to be visible, or the card is dropped.
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
            // Thin rule where the second role group starts, the same marker the recap image draws between its two groups.
            const groupBreak = c.isSecondary && i > 0 && !cats[i - 1].isSecondary;
            return `
                ${groupBreak ? '<div class="h2h-cat-divider"></div>' : ''}
                <div class="h2h-cat-row">
                    <span class="h2h-cat-val h2h-cat-home${homeWin ? ' h2h-cat-win' : ''}">${formatCatValue(hv)}</span>
                    <span class="h2h-cat-name">${escapeHtml(c.name)}</span>
                    <span class="h2h-cat-val h2h-cat-away${awayWin ? ' h2h-cat-win' : ''}">${formatCatValue(av)}</span>
                </div>`;
        }).join('');

        // Both labels ship in the markup and CSS shows one.
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

    // No card survived the visible-teams filter, so return empty and let the box show its empty state instead of a bare grid.
    if (!cards) return '';
    return `<div class="h2h-grid">${cards}</div>`;
}

// The playoff series a matchup card belongs to, so during the playoffs a card says what it is FOR.
function playoffSeriesLabelHtml(game) {
    const tier = game.playoffTierType;
    if (!tier || tier === 'NONE') return '';
    const isChamp = tier === 'WINNERS_BRACKET';
    return `<div class="h2h-series ${isChamp ? 'h2h-series-champ' : 'h2h-series-conso'}">${isChamp ? 'Championship' : 'Consolation'}</div>`;
}

// A points total in the vocabulary a points league uses: whole points stay whole, fractions keep one decimal.
function formatPoints(v) {
    const n = Number(v) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// The Matchup Race: a points league's answer to the category breakdown.
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
    // "leads by" reads wrong for a dead heat, and a tied race is worth naming plainly.
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

// The points-league counterpart to the category scoreboard, sharing the card shell and grid so the whole column-count, abbreviation and density ladder applies unchanged.
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
        // At least one side has to be visible, or the card is dropped.
        if (!AppState.visibleTeams.has(home.id) && !AppState.visibleTeams.has(away.id)) return '';
        const hPts = statValue(g.home.totalPoints) || 0;
        const aPts = statValue(g.away.totalPoints) || 0;

        const headTeam = (team, cls, winning) => `
            <div class="h2h-head-team ${cls}${winning ? ' h2h-head-lead' : ''}">
                <span class="h2h-dot" style="background:${AppState.teamColorMap[team.id]};"></span>
                <span class="h2h-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
                <span class="h2h-abbr" title="${escapeHtml(team.name)}">${escapeHtml(team.abbrev)}</span>
            </div>`;

        // The card's own race, plus a pop-out button when there is a race to enlarge. A matchup with no day-by-day data draws no chart, so it gets no button either.
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

    // No card survived the visible-teams filter, so return empty for the shared empty state.
    if (!cards) return '';
    return `<div class="h2h-grid">${cards}</div>`;
}

// Per-card pop-out. The whole-box pop-out answers "show me the week", this one answers "show me THIS matchup", which a small card in a full grid can never do properly.
let cardVisualSeq = 0;
const cardVisuals = new Map();

// Cleared at the top of every scoreboard render: the ids are positional, so stale entries would outlive the cards that own them and leak.
function resetCardVisuals() {
    cardVisuals.clear();
    cardVisualSeq = 0;
}

function registerCardVisual(visual) {
    const id = `cv${++cardVisualSeq}`;
    cardVisuals.set(id, visual);
    return id;
}

// The same glyph and button class as the other pop-outs, so it reads as one family.
function cardPopoutButtonHtml(id, label) {
    return `<button type="button" class="h2h-card-popout trends-popout-btn" data-card-visual="${id}"
        title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">⛶</button>`;
}

// One matchup's race at full size: the card's normalized sparkline redrawn as a real chart with axes, day labels and a hover readout.
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

    // Days are numbered within the MATCHUP rather than by ESPN's scoringPeriodId, which is an internal season counter that means nothing to a reader looking at one week.
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

    // The chart labels itself with each side's colour, name and final total, so the reader never needs a sentence explaining what the two lines are.
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

        // Best-first, so the readout doubles as who was ahead on this day, and .tt-rows lets the shared tooltip layout reflow and clamp it like every other hover.
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

// Which full-size renderer each registered visual kind uses. A new card visual adds a line here.
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
    // Render AFTER the overlay is visible: the chart sizes to its container, and a hidden container measures zero.
    renderer(chart, visual);
}

// Wires the overlay's close button once. The card buttons are wired per render, since the cards are rebuilt every time.
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

// Incremented on every scoreboard render, guarding its deferred ladder measurement against a superseding render.
let scoreboardRenderId = 0;

// Renders the Matchup Scoreboard into the trends box and picks the arrangement that fills it.
function renderScoreboardBox(container, week) {
    // Both league types render the same card shell into the same grid, so the column-count search, the abbreviation fallback, the density step and paging are all shared.
    resetCardVisuals();
    const html = AppState.isPointsLeague ? buildPointsScoreboardHtml(week) : buildH2HScoreboardHtml(week);
    if (!html) {
        // Empty either because the week has no matchups or because every one was filtered out, so name the second case rather than showing a bare box.
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

        // Every category row fits its card's height, and the box is not overflowing.
        const verticalOk = () =>
            container.scrollHeight <= container.clientHeight + 1 &&
            [...grid.querySelectorAll('.h2h-cats')].every(c => c.scrollHeight <= c.clientHeight + 1);

        // The card is still READABLE at this width: the visible team label shows in full, and the value row does not clip.
        const horizontalOk = () =>
            [...grid.querySelectorAll('.h2h-card')].every(card => {
                const label = card.querySelector(
                    grid.classList.contains('h2h-abbrev') ? '.h2h-abbr' : '.h2h-name');
                const row = card.querySelector('.h2h-cat-row');
                return (!label || (label.clientWidth > 0 && label.scrollWidth <= label.clientWidth + 1))
                    && (!row || row.scrollWidth <= row.clientWidth + 1);
            });

        // One arrangement, tried at three header densities in order: full team names, then abbreviations, then abbreviations with the score rounded.
        const HEADER_STEPS = [0, 1, 2]; // full name -> abbrev -> abbrev + rounded score
        const tryArrangement = (cols, compact) => {
            for (const label of HEADER_STEPS) {
                apply(cols, compact, label);
                if (horizontalOk() && verticalOk()) return true;
            }
            return false;
        };

        // How many cards are currently in the layout. Paging shows a slice, and the fit search asks whether a page of THIS size fits by showing exactly that many.
        const showFirst = (n) => cards.forEach((c, i) => { c.style.display = i < n ? '' : 'none'; });

        const searchArrangement = (n) => {
            for (const compact of [false, true]) {
                for (let cols = 1; cols <= n; cols++) {
                    if (tryArrangement(cols, compact)) return true;
                }
            }
            return false;
        };

        // Best case: every card fits at full quality, so there is nothing to page.
        showFirst(cardCount);
        if (searchArrangement(cardCount)) {
            renderScoreboardPager(pager, cardCount, cardCount, cards);
            return;
        }

        // It does not fit, so PAGE rather than degrade to an internal scroll.
        for (let perPage = cardCount - 1; perPage >= 1; perPage--) {
            showFirst(perPage);
            if (searchArrangement(perPage)) {
                renderScoreboardPager(pager, perPage, cardCount, cards);
                return;
            }
        }

        // Even one card cannot satisfy both axes, so show it anyway at the tightest legible header. One card per page is still paging, and still not a scrollbar.
        showFirst(1);
        apply(1, true, HEADER_STEPS[HEADER_STEPS.length - 1]);
        renderScoreboardPager(pager, 1, cardCount, cards);
    });
}

// Which page of matchup cards the scoreboard is showing.
let scoreboardPageIndex = 0;

// Paints the page slice and its chrome. The arrows are the same chrome arrows the category pager uses, and they WRAP, so neither ever needs a disabled state.
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

// Category Heatmap: a teams by categories grid, each cell aggregated over the selected timeframe and shaded by its rank among visible teams, inverse-aware so a low ERA reads green.
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

    // Aggregate every team's value in every category over the range, then rank per category by competition rank among the teams that have a value.
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

    // Column sort.
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
        // The arrow slot is rendered in EVERY header and only hidden when that column is not the sort. Omitting it outright let the label shift sideways the moment a column became sorted.
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
    // The same affordances the player table's sortable headers use, plus Enter and Space so the sort is reachable without a mouse.
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

// Three-state cycle per column: descending, then ascending, then back to the league's default team order.
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

// Past this many teams the band stops growing and scrolls internally instead.
const HEATMAP_MAX_VISIBLE_ROWS = 10;

// Caps the band by measuring where the last visible row actually ends rather than guessing a pixel height, since row height moves with font size, padding and border-spacing.
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

// intro is the italic explainer above the bars. The Rankings box reuses this builder where that framing does not apply and the block header already says enough, so it passes null.
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
            // Wrapped so the fit has one grid per block to drive, the same shape the season standings use.
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
        // A points league's single-week view is the Points comparison only, since a Match Wins bar for one game is a degenerate 1/0 per team.
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

    // Adaptive orientation: columns are tried FIRST because they fill both axes, and rows are the fallback for when there are too many teams to give each column a usable width.
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
        // Rows, either by choice or because the columns were too thin, get the same fit-all ladder the category blocks and season standings use.
        fitSingleWeekBars(container);
    });
}

// The fit-all ladder applied to the single-matchup blocks: one column at the natural height, two columns at that height, then a shrunk pitch, until every team is on screen.
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

    // Everything in the container that is not a row: the intro line, each block's header and its seam.
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

    // This ladder publishes the league standard exactly as the season one does, so the box's other tab has a rhythm to match.
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

    // The same bounded correction the standings fit makes, for the same reason: the estimate predates the grid, whose row boxes round differently.
    for (let guard = 0; guard < 6 && pitch > 1; guard++) {
        const over = container.scrollHeight - container.clientHeight;
        if (over <= 0) break;
        pitch = Math.max(1, pitch - Math.max(1, Math.ceil(over / slotsFor(cols))));
        apply(pitch);
    }
    // The corrective loop can shave the pitch under the tiny line after the gap was chosen, so the published rhythm is re-read from the pitch that actually shipped.
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

    // A line trend needs at least two weeks to plot, or a single-week timeframe would draw one isolated dot.
    if (startWeek === endWeek) {
        renderSingleWeekBars(container, startWeek, showCat, showMatch);
        return;
    }

    const svgWidth = 800;
    const svgHeight = 350;
    const padding = 45;

    // Two cumulative series, each with its own toggle, axis, line style and vocabulary. Channel A is the solid line on the left axis, channel B the dashed line on the right.
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

    // preserveAspectRatio="none" makes the viewBox stretch edge to edge instead of letterboxing, which the hover mapping depends on.
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
        // A label per week crams together once a long range spans 20-plus weeks, so thin them to a fixed max, evenly spaced, always including the last week.
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

    // The line keeps one consistent style throughout: the dashed boundary marker is enough to show where the playoffs start.
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

        // Header plus one row per team, wrapped in .tt-rows so the shared tooltip layout can reflow the rows into columns rather than clipping a deep league. The data is sorted best-first, so the reflow reads as a mini-standings.
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

// The Roto Race: one cumulative roto-points line per team over the season, in the same visual language as the trends chart.
function renderRotoRaceGraph(container) {
    const sport = AppState.loadedSport;

    // Kick every source the race needs BEFORE deciding what to draw, since the series holds a loading state until they land and starting them afterwards would wait forever.
    if (!weeklyDataFailed()) ensureWeeklyDataForRace(sport);
    ensureRosterSnapshotData(sport);
    ensureRosterTransactionData(sport);

    const race = buildRotoRaceSeries(sport);

    // One loading line held until the best expected tier is complete, then exactly one chart.
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

    // The axis is scaled to every team's peak, not just the visible ones, so toggling a line never rescales the chart under the remaining lines.
    let maxPts = 0;
    race.seriesByTeam.forEach(series => series.forEach(v => { if (v > maxPts) maxPts = v; }));
    maxPts = getNiceMax(maxPts);
    const yAt = (v) => svgHeight - padding - (v / maxPts) * (svgHeight - padding * 2);

    // preserveAspectRatio="none" for the same reason as the trends chart: the hover mapping assumes the viewBox fills the element edge to edge.
    let svgStr = `<svg id="roto-race-svg" width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none" style="display:block; cursor:crosshair; flex:1;">`;
    const formatTick = (val) => val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatTick(maxPts - (i / 4) * maxPts)}</text>`;
    }
    svgStr += `<line id="roto-hover-line" y1="${padding}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="4,2" display="none" pointer-events="none" style="stroke:var(--chart-axis)" />`;

    // Thin the x labels to around ten so a full season does not crowd, always keeping the last.
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil(numPoints / maxLabels));
    weeks.forEach((wk, i) => {
        if (i % labelStep !== 0 && i !== numPoints - 1) return;
        svgStr += `<text x="${xAt(i)}" y="${svgHeight - 10}" font-size="12" text-anchor="middle" style="fill:var(--chart-axis)">${axisUnit().short}${wk}</text>`;
    });

    // The standings column at each week, sorted best-first for the tooltip.
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

    // The subtitle names the crediting source so the accuracy is never oversold, one line per rung of the fallback ladder: daily started lineups, then the transaction roster history, then current rosters.
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

        // The same reflow-to-fit treatment as the trends hover, so a tall roster of teams breaks into columns instead of clipping.
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

// Incremented on every category render, guarding its deferred measurement against a superseding render.
let catGraphRenderId = 0;

// Which category the box is showing. Module state rather than AppState, because it is pure view position.
let catViewedStatId = null;

// Which standings sections are currently drawn as a pie, by section key. A Set rather than one flag, because the sections flip independently.
const sectionPieViews = new Set();

export function resetRankingsViewState() {
    catViewedStatId = null;
    sectionPieViews.clear();
    scoreboardPageIndex = 0;
    // A new league has its own density, so its standard rhythm is measured afresh rather than inherited from whatever the last one could afford.
    leagueLadder = null;
}

// The canonical Category Rankings row pitch lives in CSS now, as one pitch everywhere rather than a cap that only engaged when the fill would stretch past it.

// One category's RACE: each team's cumulative value in that category, week by week, under its ranking bars.
function buildCategoryRaceSeries(catId, teams, startWeek, endWeek) {
    if (AppState.isRotoLeague) {
        const sport = AppState.loadedSport;
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

// Registry of the race data behind each rendered block, keyed by render id, so the hover can answer with exact values without re-deriving anything. Cleared per render.
let catRaceSeq = 0;
const catRaceData = new Map();

// The race markup.
function buildCategoryRaceHtml(series, isInverse) {
    if (!series) return '';
    const { weeks, points } = series;
    const n = weeks.length;
    const flat = points.flatMap(p => p.values).filter(v => v !== undefined && Number.isFinite(v));
    if (flat.length === 0) return '';
    const peak = Math.max(...flat), floor = Math.min(...flat, 0);
    const span = (peak - floor) || 1;
    const yPct = (v) => 100 - ((v - floor) / span) * 100;
    const xPct = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;

    // The race indexes whatever the league's own timeline is: matchups in H2H, weeks in roto.
    const unit = axisUnit();
    const id = `cr${++catRaceSeq}`;
    catRaceData.set(id, series);

    const polys = points.map(p => {
        const pts = p.values.map((v, i) => v === undefined ? null : `${xPct(i)},${yPct(v)}`).filter(Boolean).join(' ');
        return pts ? `<polyline points="${pts}" fill="none" vector-effect="non-scaling-stroke" stroke="${AppState.teamColorMap[p.id]}" stroke-width="1.5" opacity="0.9" />` : '';
    }).join('');

    // End-value labels, best-first so the leaders win any collision. The deferred pass hides labels that would overlap, which is what keeps this readable as the team count climbs.
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
            <div class="cat-race-axis"><span>${unit.short}${weeks[0]}</span><span>${unit.short}${weeks[n - 1]}</span></div>
        </div>`;
}

// Hover on a category race: teams and their exact cumulative values at the hovered week, best-first, through the shared tooltip layout.
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
            // The viewBox stretches edge to edge, so the cursor ratio maps straight onto the index with no letterbox correction.
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

            tooltip.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">${escapeHtml(raceEl.dataset.cat || '')} thru ${axisUnit().long} ${series.weeks[i]}</div><div class="tt-rows">${rows}</div>`;
            tooltip.style.display = 'block';
            layoutHoverTooltip(tooltip, e.clientX, e.clientY);
        });

        plot.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
            hairline.hidden = true;
        });
    });
}

// Row pitch and the smallest race worth drawing, in px, both read here so the layout can decide what fits before anything is painted.
const CAT_ROW_PITCH = 28;
// Race band heights INCLUDING the race's own chrome, since budgeting the band without it turns an advertised band into a fraction of one.
const CAT_RACE_MIN = 74;
const CAT_RACE_FLOOR = 33;
// The block header's full occupied height, margin included, because the margin is as real to the layout as the text.
const CAT_HEADER_H = 28;
const CAT_HEADER_SHRUNK_H = 28;
// The category pager's own chrome, where the page indicator sits. The container's own padding is measured rather than assumed.
const CAT_PAGER_PAD = 12;
// There is deliberately no minimum-pitch constant: clamping the pitch UP to a readable floor overflows the very box the shrink exists to fit inside, which clips the last team.
const CAT_PITCH_SHRUNK = 22;

// Lays the Category Rankings box out, from data rather than finished markup, because the layout decides how the rows are arranged.
function renderCategoryBlocks(container, blocks) {
    // clientHeight INCLUDES the container's own padding, which the block never gets to use.
    const cs = getComputedStyle(container);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const height = Math.max(0, (container.clientHeight || 240) - pad);

    // The viewed category is remembered by STAT ID rather than index, because the Advanced Stats toggle changes the list's length and order and an index would land on a different category.
    let viewIndex = blocks.findIndex(b => b.id === catViewedStatId);
    if (viewIndex < 0) viewIndex = 0;
    catViewedStatId = blocks[viewIndex]?.id ?? null;
    const block = blocks[viewIndex];
    if (!block) return;

    const rowCount = block.rowsHtml.length;
    const hasRace = !!block.race;

    // The height budget has to include the pager's chrome, or the block overruns the box by exactly that much.
    const chrome = blocks.length > 1 ? CAT_PAGER_PAD : 0;
    const avail = Math.max(0, height - chrome);
    // Rows per column and the height left for the race, for a given column count at a given pitch. The gaps between rows are real height, so the leftover the race bids against is net of them.
    const standardGap = leagueLadder ? leagueLadder.gap : STD_NATURAL_GAP;
    const gapFor = pitch => (pitch < STD_PITCH_TINY ? Math.min(rowGapFor(pitch), standardGap) : standardGap);

    // When the standings tab is placing the SAME number of rows, both tabs are drawing the same picture and have no business drawing it at two heights. Only ever downward, since a pitch the standings could place is one this tab can place too.
    const twinLadder = !!leagueLadder && leagueLadder.rows === rowCount && leagueLadder.pitch > 0;
    const canonicalPitch = twinLadder ? Math.min(CAT_ROW_PITCH, leagueLadder.pitch) : CAT_ROW_PITCH;

    const fitFor = (cols, pitch = canonicalPitch) => {
        const perCol = Math.ceil(rowCount / cols);
        const gap = gapFor(pitch);
        const gaps = Math.max(0, perCol - 1) * gap;
        return { cols, perCol, pitch, gap, leftover: avail - (CAT_HEADER_H + perCol * pitch + gaps) };
    };

    // The ladder in preference order. Fewest columns wins and a full-height race beats a short one, but EVERY rung shows every team: none of them drops or pages a single one.
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
        // Nothing holds every team at the canonical pitch, so the pitch yields: divide the real track height by the rows that must sit in it. Floored at 1px only to stay positive, and deliberately not clamped up to a readable minimum, which would overflow the box.
        cols = 2;
        showRace = false;
        rowsPerCol = Math.ceil(rowCount / cols);
        const track = avail - CAT_HEADER_SHRUNK_H;
        const gaps = Math.max(0, rowsPerCol - 1);
        // Solve for the pitch with the gaps already paid for, then once more if that pitch is tiny enough for the cheaper gap, the same two-step the standings fit uses.
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

    // A band under the minimum goes tight: the week-span axis is dropped and its height goes to the plot.
    const tightRace = showRace && chosen && chosen.fit.leftover < CAT_RACE_MIN;
    const raceHtml = showRace ? buildCategoryRaceHtml(block.race, block.inverse) : '';
    const race = raceHtml
        ? raceHtml.replace('<div class="cat-race" ', `<div class="cat-race${tightRace ? ' cat-race-tight' : ''}" data-cat="${escapeHtml(block.name)}" data-inverse="${block.inverse ? 1 : 0}" `)
        : '';
    // Two-column mode clamps the team name to its short form, since at half width a full-width title would leave the track nothing to say. The shrunk class is the sub-canonical pitch: tighter type and no value labels.
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

    // One measured pass over the end labels. It only ever clamps a label inside the plot or hides one that would collide, so it cannot move the box.
    const renderId = ++catGraphRenderId;
    requestAnimationFrame(() => {
        if (renderId !== catGraphRenderId) return;
        // The label column is measured here too, so the category bars close the same grey channel the standings bars do. Width-only, so it cannot disturb the fit decided above.
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

    // Every category the league has, in role-grouped order, cycled one per screen.
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

    // One ranking block per category. Exactly one shows at a time and the arrows cycle the rest, so every block is built at full width and height.
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

        // Just the stat name, since the box title already says Category Rankings.
        const rowsHtml = [];

        const formatVal = (v) => (v % 1 !== 0) ? v.toFixed(3) : v;

        // The solid-bar decision is per BLOCK, not per team: if any team's tier component is negative the whole block renders solid, so a block never mixes shaded and solid rows.
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
