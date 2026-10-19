/**
 * Renders the Team Metrics tab: the Rankings box (standings, category rankings, playoff odds and
 * the head-to-head matrix), the Season Trends box or matchup scoreboard, the category heatmap
 * band, and the pre-draft and projected faces a league wears before it has played.
 *
 * The rendering reads the application state and writes into the page; the rank math itself lives
 * in the engine modules it imports.
 * @module graphs
 */
import { AppState, AVERAGE_STATS, leagueInverseIds, ESPN_STAT_MAPS, categoriesMapped, LINEUP_SLOT_LABELS, LINEUP_SLOT_ORDER, NON_STARTING_SLOTS, RATE_COMPONENTS, FLEX_SLOTS, FLEX_SLOT_POSITIONS, nonStartingLabels } from '../data/state.js';
import { seasonState, SEASON_STATE } from '../data/season-state.js';
import { countdownCard, slotSeatsFor, lastSeasonCard, rankedPoolCard, projectedCategoryRanks, draftPickRows } from '../engines/preseason-face.js';
import {
    projectedTeamSums, projectedValues, projectedRotoStandings, projectedPointsStandings, placeOf
} from '../engines/projected-basis.js';
import { positionDepth } from '../engines/draft-engine.js';
import { rotoPointsForCategory } from '../engines/rank-engine.js';
import { buildProTeamAbbrevs, buildGamePeriodIndex } from '../engines/probables.js';
import { loadMostRecentPastSeason, currentProSchedule, fetchProTeamSchedules, readOddsCache, writeOddsCache } from '../data/api.js';
import { rulesFrom, resampleBasis, simulateSeason, MIN_WEEKS, rotoBasisFrom, rotoOdds, oddsFigure, remainingSchedule } from '../engines/playoff-odds.js';
import { oddsSeed, batchFor, runInBatches, yieldFrom, playedFingerprint, oddsCacheKey, oddsCacheRecord, oddsCacheIsFresh, ODDS_RUNS } from '../engines/odds-runner.js';
import { summarizeSeason, franchiseKeyOf } from '../engines/history.js';
import { movementFor } from '../engines/standings-movement.js';
import { h2hSeriesFor, h2hCellFor } from '../engines/h2h-series.js';
import { findOwnedTeamId } from './utils.js';
import { gameDayRace } from '../engines/schedule-insight.js';
import { buildLineupGroundHtml, buildMockLineupGroundHtml } from './lineup-ground.js';
import { buildPlayerAvatarHtml, wirePlayerAvatars, proTeamLogoUrl } from './images.js';
import { sampleLogoColour, toCssRgb } from './logo-colour.js';
import { seatsFor as mockSeatsFor, emptyState as mockEmptyState, seat as mockSeat, unseat as mockUnseat, clear as mockClear, canSeat as mockCanSeat, summary as mockSummaryOf } from '../engines/mock-lineup.js';
import { MIN_MATCHUPS_FOR_A_LINE, getZoomedFillPct, getTimeframeBounds, getNiceMax, getWeekTier, tierColor, splitByTier, escapeHtml, attachDataTooltips, percentileVar, orderStatIdsByRole, splitStatIdsByRole, statValue, layoutHoverTooltip, categoryCycleList, categoryHeaderLabel, axisUnit, parseTimeframe, matchupRangeFor, matchupPoints, matchupTally, unmappedCategoriesNote, buildLoadingHtml, displayTeamName, teamNameTitle, draftTypeLabel, advancedCategoryCount } from './utils.js';
import { buildBoard, buildRotoRaceSeries, ensureWeeklyDataForRace, weeklyDataFailed, ensureRosterTransactionData, ensureRosterSnapshotData, ensureDraftPicks, draftPicksFor, activeRotoWindow, computeRotoWindow, rotoCategorySeries, rotoCategoryDailySeries, matchupCategoryDailySeries, ensureMatchupLineups, teamCategorySeries, revalidateStalePoolIfDue, matchupPeriodMap, periodsOfMatchup, rotoStartedSums } from './players.js';
import { buildRankingsDonutHtml } from './rankings-donut.js';
import { categorySpread } from '../engines/category-spread.js';

const TIER_LABELS = { reg: 'Regular Season', playoff: 'Playoffs', consolation: 'Consolation' };

// The donut's pixel size in the Rankings box, fixed because the view is its own body and never overlays the bars.
const RANKINGS_DONUT_SIZE = 132;
// Headroom held back from the row budget. Rows, borders and the header's line box all resolve at sub-pixel sizes that round UP into the container's integer scrollHeight, so fitting the box exactly still produces a scrollbar; this is the margin that keeps the total honestly under it.
const STD_FIT_SLACK = 6;
const STD_PITCH_TINY = 20;
// Clear space between stacked bars so the column reads as one bar per team rather than a striped block.
const STD_ROW_GAP = 2;

// One separation rule for every fitted bar ladder, keyed off the pitch so only a change in density can move it.
function rowGapFor(pitch) {
    return pitch < STD_PITCH_TINY ? 1 : STD_ROW_GAP;
}

// The standings ladder's standard bar gap, published for the category rows to adopt; null until a visible render measures one.
let leagueLadder = null;
// What an unfitted standings ladder shows, kept in sync with the.bar-row-group margin rule.
const STD_NATURAL_GAP = 6;

// A bar too short to hold its label drops the inline value and shows it as a hover tooltip instead.

// Renders a bar's fill as one segment per tier, each with its own tooltip, collapsing to one segment when a single tier supplies the value.
function buildBarSegments(split, baseColor, overallTooltip, formatVal = (v) => v.toFixed(1), forceSolid = false) {
    const { reg, playoff, consolation, total } = split;
    const tierVals = [
        { val: reg, tier: 'reg' },
        { val: playoff, tier: 'playoff' },
        { val: consolation, tier: 'consolation' }
    ];
    const parts = tierVals.filter(p => p.val > 0);

    // A negative tier breaks the per-tier proportions, so the bar collapses to one solid segment and the split moves into the tooltip.
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

// The one section header used by every block in the Rankings box, so both tabs place the underline and first row identically.
function buildBlockHeaderHtml(title, trailing = '') {
    return `
        <div class="section-head">
            <h4 title="${escapeHtml(title)}">${escapeHtml(title)}</h4>
            ${trailing}
        </div>`;
}

// The placeholder shown when the reader's own filters leave nothing to draw.
function buildEmptyStateHtml(message) {
    return `<div class="empty-state">${message}</div>`;
}

// One team's row in a bar-comparison block; callers differ only in how they compute the values.
function buildComparisonBarRowHtml({ name, abbrev, val, color, minVal, maxVal, leaderVal, isLeader, split, formatVal = (v) => v.toFixed(1), forceSolid = false, density = '' }) {
    const fillPct = getZoomedFillPct(val, minVal, maxVal);
    const displayVal = formatVal(val);
    const overallTooltip = isLeader
        ? `${displayVal}: Leader`
        : `${displayVal}: ${formatVal(Math.abs(leaderVal - val))} back`;
    const segments = buildBarSegments(split, color, overallTooltip, formatVal, forceSolid);

    return `
        <div class="bar-row${isLeader ? ' is-leader' : ''}">
            ${buildBarTitleHtml(name, abbrev)}
            <div class="bar-track">
                <div class="bar-fill" style="width:${fillPct}%;">
                    ${segments}
                </div>
            </div>
            <span class="bar-value">${displayVal}</span>
            ${density}
        </div>
    `;
}

// Splits the champion's trailing crown into its own span so a style can hide or redraw it without touching the name string.
const NAME_CROWN = ' \u{1F451}';

function buildBarTitleHtml(name, abbrev) {
    const crowned = name.endsWith(NAME_CROWN);
    const bare = crowned ? name.slice(0, -NAME_CROWN.length) : name;
    const crownHtml = crowned ? `<span class="bar-title-crown">${NAME_CROWN}</span>` : '';
    // The abbreviation carries the crown too, falling back to the bare name so the glyph is never printed twice.
    const short = abbrev || bare;
    // The tooltip keeps the whole name, crown included, so it matches the legend.
    return `<span class="bar-title" title="${escapeHtml(name)}"
        ><span class="bar-title-full">${escapeHtml(bare)}${crownHtml}</span
        ><span class="bar-title-abbr">${escapeHtml(short)}${crownHtml}</span></span>`;
}

// One team's vertical column in a single-matchup ranking, so the chart fills both axes of the box.
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

// The W-L-T record by tier, read through an accessor because points leagues keep results apart from points.
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

// One team's standings row: a single bar scaled to the range total, split into one segment per tier.
function buildStandingsBarRowHtml({ teamId, name, abbrev, color, split, overallMax, recordByTier, isLeader, density = '' }) {
    const widthPct = overallMax > 0 ? (split.total / overallMax) * 100 : 0;
    const isChampion = teamId === AppState.championTeamId;

    // A tier counts as present if any week was played in it, so an empty playoff run still shows as a sliver.
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

    // The value sits in its own column at the end of the row so a short bar can always show its number.
    return `
        <div class="bar-row-group">
            <div class="bar-row${isLeader ? ' is-leader' : ''}${isChampion ? ' is-champion' : ''}">
                ${buildBarTitleHtml(name, abbrev)}
                <div class="bar-track">
                    <div class="bar-fill" style="width:${widthPct}%;">
                        ${segmentsHtml}
                    </div>
                </div>
                <span class="bar-value">${totalLabel}</span>
                ${density}
            </div>
        </div>
    `;
}

// Incremented on every left-column render so the deferred pie placement can tell it is stale.
let leftColumnRenderId = 0;

// The Rankings box shows one view at a time; this dispatcher syncs the tabs and containers with that state, then renders it.

/**
 * Renders the Rankings box's active view (standings, category rankings, playoff odds or the
 * head-to-head matrix) into its containers and syncs the tab chrome with the box's state.
 * Takes no arguments; it reads everything from the application state.
 * @returns {void}
 */
export function renderLeftColumn() {
    const isCategory = AppState.rankingsBoxView === 'category';
    // A projected league has no played weeks to resample, so both views use the roto pair of standings and category values.
    if (projectedBasisOn) {
        updateRankingsBoxChrome(isCategory, false, false);
        if (isCategory) renderRotoCategoryGraph();
        else renderRotoStandings();
        return;
    }
    // Computed every render so the tab strip always knows whether to offer Playoff Odds, not only once it is clicked.
    const rules = playoffOddsRulesFrom();
    const playoffsEligible = playoffOddsEligible(rules);
    const isPlayoffs = !isCategory && playoffsEligible && AppState.rankingsBoxView === 'playoffs';
    const h2hEligible = h2hTabEligible();
    const isH2h = !isCategory && !isPlayoffs && h2hEligible && AppState.rankingsBoxView === 'h2h';
    updateRankingsBoxChrome(isCategory, isPlayoffs, playoffsEligible, rules, isH2h, h2hEligible);
    if (isPlayoffs) {
        ensurePlayoffOdds(rules);
        renderPlayoffOddsGraph(rules);
        return;
    }
    if (isH2h) {
        renderH2hTab();
        return;
    }
    if (AppState.isRotoLeague) {
        if (isCategory) renderRotoCategoryGraph();
        else renderRotoStandings();
        return;
    }
    if (isCategory) {
        renderCategoryGraph();
        return;
    }
    renderStandings();
}

// Points the box's chrome at the active view: which tab reads as active, which container shows, and which header control sits beside the tabs.
function updateRankingsBoxChrome(isCategory, isPlayoffs, isPlayoffsEligible, rules, isH2h = false, isH2hEligible = false) {
    const tabStandings = document.getElementById('rankings-tab-standings');
    const tabCategory = document.getElementById('rankings-tab-category');
    const tabPlayoffs = document.getElementById('rankings-tab-playoffs');
    const tabH2h = document.getElementById('rankings-tab-h2h');
    if (tabStandings) tabStandings.classList.toggle('active', !isCategory && !isPlayoffs && !isH2h);
    if (tabCategory) tabCategory.classList.toggle('active', isCategory);
    if (tabPlayoffs) {
        tabPlayoffs.style.display = isPlayoffsEligible ? '' : 'none';
        tabPlayoffs.classList.toggle('active', isPlayoffs);
    }
    // The fourth tab is offered once the league has a series to show and hidden otherwise.
    if (tabH2h) {
        tabH2h.style.display = isH2hEligible ? '' : 'none';
        tabH2h.classList.toggle('active', isH2h);
    }

    // The box has one shared info mark, so its text is swapped per view and restored on every render that is not Playoff Odds.
    const rankingsHint = document.getElementById('rankings-box-tooltip');
    if (rankingsHint) {
        rankingsHint.setAttribute('data-hint', isPlayoffs
            ? ((rules && rules.scoring === 'roto') ? RANKINGS_HINT_PLAYOFFS_ROTO : RANKINGS_HINT_PLAYOFFS_H2H)
            : RANKINGS_HINT_DEFAULT);
    }

    document.getElementById('left-graph-container').style.display = isCategory ? 'none' : 'flex';
    document.getElementById('cat-graph-container').style.display = isCategory ? 'flex' : 'none';
}

function renderStandings() {
    const graph = document.getElementById('left-graph-container');
    graph.innerHTML = '';

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);

    // A single matchup cannot make a W-L record, so this shows the ranking that is real for one week: categories won or points scored.
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

    // Filtered by the visible teams like every other Team Metrics box; an all-hidden filter shows the shared empty state.
    const leftData = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id)).map(t => {
        let mWins = 0, cWins = 0, pointWins = 0;
        for (let w = startWeek; w <= endWeek; w++) {
            mWins += t.weeklyMatchWins[w] || 0;
            cWins += t.weeklyCatWins[w] || 0;
            pointWins += t.weeklyMatchResult[w] || 0;
        }
        return { id: t.id, name: displayTeamName(t), mWins, cWins, pointWins, team: t };
    });

    if (leftData.length === 0) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // The row tail is always the game record, never the section's own total, over the box's own selected span and the shared window.
    const recordScoring = AppState.isPointsLeague ? 'points' : 'categories';
    const recordResultAt = AppState.isPointsLeague ? (t, w) => t.weeklyMatchResult[w] : (t, w) => t.weeklyMatchWins[w];
    const sharedWindow = parseTimeframe(AppState.timeframe).window;
    const movementInput = leftData.map(d => d.team);
    const densityFor = (team) => buildRowDensityHtml(team, {
        startWeek, endWeek, window: sharedWindow,
        scoring: recordScoring, resultAt: recordResultAt, input: movementInput
    });

    // One standings section: a header and one segmented bar per team over the visible teams, sorted by the section's total.
    const shareKey = AppState.isPointsLeague ? 'points' : 'cat';
    const buildSection = ({ key, header, valueKey, weekValue, resultAt, isLast }) => {
        const teams = [...leftData].sort((a, b) => b[valueKey] - a[valueKey]);
        const asPie = sectionFace(key) === 'pie';
        const tailFor = key === shareKey
            ? (tv) => (AppState.isPointsLeague
                ? buildPointsMarginHtml(tv.id, { startWeek, endWeek })
                : buildCatShareHtml(tv.id, { startWeek, endWeek }))
            : (tv) => densityFor(tv.team);
        // The bars are built only when they are the body actually shown, since the donut is an alternate view.
        let barsBody = '';
        if (!asPie) {
            const splits = teams.map(tv => splitByTier(tv.team, startWeek, endWeek, w => weekValue(tv.team, w)));
            const overallMax = Math.max(...splits.map(s => s.total));
            barsBody = teams.map((tv, i) => buildStandingsBarRowHtml({
                teamId: tv.id, name: tv.name, abbrev: tv.team?.abbrev, color: AppState.teamColorMap[tv.id],
                // Read off the value rather than position, so a tie at the top marks both rows.
                isLeader: overallMax > 0 && splits[i].total === overallMax,
                split: splits[i], overallMax,
                recordByTier: resultAt ? computeRecordByTier(tv.team, startWeek, endWeek, resultAt) : null,
                density: tailFor(tv)
            })).join('');
        }
        return buildStandingsSectionHtml({
            key, header, isLast, asPie, barsBody,
            pieBody: asPie ? buildSectionDonutHtml(teams, valueKey, { resultAt, startWeek, endWeek }) : ''
        });
    };

    // Points leagues get Match Wins and Points For; category leagues get H2H Match Wins and Category Wins. Both lead with a record-bearing section.
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

    // The series matrix has its own header tab, so this view holds two sections. The column fills the box so a flipped section has room to expand.
    graph.innerHTML = `<div class="std-sections">${sectionsHtml}</div>`;

    attachDataTooltips(graph);
    wireSectionFlips(graph, renderStandings);

    // Measured in the next animation frame, because a synchronous read came back stale on the first call of a page load; renderId drops a superseded call.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;
        fitStandingsSections(graph);
        sizeStandingsBarTitles(graph);
        observeStandingsFit(graph);
    });
}

// ==== Playoff odds ====

// Defined locally like every other file here, since no module exports it.
const MIDDOT = String.fromCharCode(183);
// An ordinal reads as a measured fact where a percent would read as a probability.
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// One computation at a time, keyed by sport, league and period; a new key cancels the old run so it stops spending idle time.
let playoffOddsState = null;

function playoffOddsKey() {
    return `${AppState.loadedSport}:${AppState.apiData?.id}:${AppState.maxCompletedWeek}`;
}

// The inputs to rulesFrom, assembled from application state; the division map has no other builder.
function playoffOddsRulesFrom() {
    const sport = AppState.loadedSport;
    const divisionByTeam = {};
    (AppState.apiData?.teams || []).forEach(t => { if (t && t.id !== undefined) divisionByTeam[t.id] = t.divisionId; });
    return rulesFrom(AppState.apiData?.settings, AppState.apiData?.schedule || [], {
        scoredStatIds: [...(AppState.scoredStatIds || [])],
        inverseStatIds: [...leagueInverseIds(sport)],
        divisionByTeam,
        rateComponents: RATE_COMPONENTS[sport] || []
    });
}

// The two bracket shapes rulesFrom decides between. A playoff team count of zero is neither, so the tab stays off.
function playoffOddsSeatsCanBeMissed(rules) {
    return !!rules && rules.scoring !== 'roto' && rules.playoffTeamCount > 0 && rules.playoffTeamCount < rules.teamCount;
}
function playoffOddsEveryoneSeated(rules) {
    return !!rules && rules.scoring !== 'roto' && rules.playoffTeamCount > 0 && rules.playoffTeamCount >= rules.teamCount;
}
// Roto is its own shape. Whether there is enough played data to run is the empty state's question, so the tab still offers itself.
function playoffOddsRoto(rules) {
    return !!rules && rules.scoring === 'roto';
}
function playoffOddsEligible(rules) {
    return playoffOddsSeatsCanBeMissed(rules) || playoffOddsEveryoneSeated(rules) || playoffOddsRoto(rules);
}

// The shared info mark's text while Playoff Odds is active. The run counts are literals so they cannot drift from the constant.
const RANKINGS_HINT_DEFAULT = 'Team Rankings shows H2H and Category Wins standings. Bars shade darker for playoffs, lighter for consolation. Each arrow swaps its bars for a pie.\n\nCategory Rankings ranks teams by their total in one category. The arrows cycle every category the league scores, and Advanced Stats adds the rest.';
const RANKINGS_HINT_PLAYOFFS_H2H = "Odds from your league's own results so far, over 100,000 simulated seasons.";
const RANKINGS_HINT_PLAYOFFS_ROTO = "Odds from your league's own results so far, over 10,000 simulated seasons.";

// The byes are arithmetic, because ESPN does not generate bracket games until the season reaches them. The bracket is the next power of two at or above the seat count.
function playoffOddsByeCount(rules) {
    const seats = Math.floor(Number(rules && rules.playoffTeamCount) || 0);
    if (seats <= 0) return 0;
    let bracket = 1;
    while (bracket < seats) bracket *= 2;
    return bracket - seats;
}

// Starts the computation for the current key if none is running or done; a no-op otherwise, so a league switch is noticed at once.
function ensurePlayoffOdds(rules) {
    const key = playoffOddsKey();
    if (playoffOddsState && playoffOddsState.key === key) return;
    // A different key means a league switch or a new period; cancelling stops the old run spending idle time.
    if (playoffOddsState) playoffOddsState.cancelled = true;
    if (rules.scoring === 'roto') ensurePlayoffOddsRoto(rules, key);
    else ensurePlayoffOddsH2H(rules, key);
}

// The last decided matchup period, not the max completed week, because a point scored in an undecided matchup would otherwise churn the cache key.
function lastDecidedMatchupPeriod(schedule, currentMatchup) {
    const decided = (schedule || [])
        .filter(g => g && (g.winner === 'HOME' || g.winner === 'AWAY' || g.winner === 'TIE'))
        .map(g => Number(g.matchupPeriodId))
        .filter(Number.isFinite);
    if (decided.length) return Math.max(...decided);
    return Math.max(0, (Number(currentMatchup) || 0) - 1);
}

function ensurePlayoffOddsH2H(rules, key) {
    const leagueId = AppState.apiData?.id;
    const sport = AppState.loadedSport;
    const schedule = AppState.apiData?.schedule || [];
    const period = lastDecidedMatchupPeriod(schedule, AppState.currentMatchup);
    const basis = resampleBasis(AppState.teamStats, { through: period, scoring: rules.scoring });
    const fingerprint = playedFingerprint(AppState.teamStats, { through: period });
    const runs = ODDS_RUNS.h2h;
    const remainingMatchups = schedule.filter(g => g && g.home && g.away
        && (!g.playoffTierType || g.playoffTierType === 'NONE')
        && Number(g.matchupPeriodId) <= rules.regSeasonWeeks
        && g.winner !== 'HOME' && g.winner !== 'AWAY' && g.winner !== 'TIE').length;
    const batch = batchFor({ path: 'h2h', matchups: remainingMatchups });

    const state = { key, status: 'loading', result: null, progress: 0, cancelled: false, runs, batch };
    playoffOddsState = state;

    // Too few played weeks to resample; skipping straight to the empty state avoids idling through batches that would each say so.
    if ((basis.weeksUsed || 0) < MIN_WEEKS) {
        state.status = 'empty';
        state.result = { teams: {}, runs: 0, seed: oddsSeed(leagueId, period), weeksUsed: basis.weeksUsed, state: 'too few weeks to resample' };
        if (AppState.rankingsBoxView === 'playoffs') renderLeftColumn();
        return;
    }

    // Season-to-date points for are read from the league's teams so a points tie-break does not rest on simulated points alone.
    const pointsFor = {};
    (AppState.apiData?.teams || []).forEach(t => { if (t && t.id !== undefined) pointsFor[t.id] = Number(t.record?.overall?.pointsFor) || 0; });
    const variant = rules.seedingRule === 'TOTAL_POINTS_SCORED' ? 'season-pf' : 'season';
    const cacheKey = oddsCacheKey(sport, leagueId);
    const seed = oddsSeed(leagueId, period);
    runOddsCached({
        state, cacheKey, seed,
        keyFields: { sport, leagueId, period, fingerprint, runs, batch, variant },
        simulate: (batchSeed, n) => simulateSeason(basis, schedule, rules, { seed: batchSeed, runs: n, minWeeks: MIN_WEEKS, pointsFor }),
        cancelledResult: { teams: {}, runs: 0, seed, weeksUsed: basis.weeksUsed, state: 'cancelled' }
    });
}

// The roto path reads the Roto Race's own per-team weekly sums, which exist only after lineups are harvested, so the common case is an empty state.
function ensurePlayoffOddsRoto(rules, key) {
    const leagueId = AppState.apiData?.id;
    const sport = AppState.loadedSport;
    const period = AppState.maxCompletedWeek;
    const runs = ODDS_RUNS.roto;
    const state = { key, status: 'loading', result: null, progress: 0, cancelled: false, runs, batch: null };
    playoffOddsState = state;

    const acc = rotoStartedSums(sport);
    if (!acc || !acc.weeks.length) {
        state.status = 'empty';
        state.result = { teams: {}, runs: 0, seed: oddsSeed(leagueId, period), state: 'no started-lineup history yet' };
        if (AppState.rankingsBoxView === 'playoffs') renderLeftColumn();
        return;
    }
    const basis = rotoBasisFrom(acc.teamWeeklySums, { through: null, lastN: null });
    if ((basis.periodsUsed || 0) < MIN_WEEKS) {
        state.status = 'empty';
        state.result = { teams: {}, runs: 0, seed: oddsSeed(leagueId, period), state: 'too few weeks to resample' };
        if (AppState.rankingsBoxView === 'playoffs') renderLeftColumn();
        return;
    }

    const standings = {};
    AppState.teamStats.forEach(t => { standings[t.id] = t.seasonCats || {}; });
    const latestWeek = acc.weeks[acc.weeks.length - 1] || 0;
    const totalWeeks = Number(AppState.regSeasonWeeks) || latestWeek;
    const periodsLeft = Math.max(0, totalWeeks - latestWeek);

    const fingerprint = playedFingerprint(acc.teamWeeklySums, { through: null });
    const batch = batchFor({ path: 'roto', teams: Object.keys(standings).length, periodsLeft });
    state.batch = batch;

    const cacheKey = oddsCacheKey(sport, leagueId);
    const seed = oddsSeed(leagueId, period);
    runOddsCached({
        state, cacheKey, seed,
        keyFields: { sport, leagueId, period, fingerprint, runs, batch, variant: 'season' },
        simulate: (batchSeed, n) => rotoOdds(basis, standings, rules, { seed: batchSeed, runs: n, periodsLeft }),
        cancelledResult: { teams: {}, runs: 0, seed, state: 'cancelled' }
    });
}

// The read-cache, run-in-batches, write-cache block both odds paths share. keyFields is everything that decides whether a stored result is still the answer.
function runOddsCached({ state, cacheKey, keyFields, simulate, seed, cancelledResult }) {
    const { runs, batch } = keyFields;
    readOddsCache(cacheKey).then(record => {
        if (state.cancelled) return null;
        if (oddsCacheIsFresh(record, keyFields)) {
            return record.result;
        }
        return runInBatches({
            simulate,
            runs, batch, seed,
            yieldTo: yieldFrom(window),
            onProgress: ({ done, total }) => {
                if (state.cancelled) return;
                state.progress = Math.round((done / total) * 100);
                paintPlayoffOddsProgress(state);
            },
            cancelled: () => state.cancelled
        }).then(result => {
            if (!result || state.cancelled) return result;
            writeOddsCache(cacheKey, oddsCacheRecord({
                ...keyFields, seed: result.seed, computedAt: Date.now(), result
            }));
            return result;
        });
    }).then(result => {
        if (state.cancelled) return;
        state.status = result ? 'done' : 'empty';
        state.result = result || cancelledResult;
        paintPlayoffOddsProgress(state);
        if (AppState.rankingsBoxView === 'playoffs') renderLeftColumn();
    });
}

// Patches the tab label directly rather than doing a full render on every batch.
function paintPlayoffOddsProgress(state) {
    const tab = document.getElementById('rankings-tab-playoffs');
    if (!tab) return;
    tab.textContent = (state.status === 'loading' && state.progress < 100) ? `Playoff Odds ${state.progress}%` : 'Playoff Odds';
}

// One team's berth-chance row. The bar width is the sampled odds, and only the value text becomes a word when a team has clinched or been eliminated.
function oddsSchedHtml(sched) {
    if (!sched || !sched.gamesLeft) return '<span class="bar-sched"></span>';
    const rec = `${sched.wins}-${sched.losses}${sched.ties ? `-${sched.ties}` : ''}`;
    const tip = `Opponents in the ${sched.gamesLeft} games left, combined: ${rec}`;
    return `<span class="bar-sched" data-tooltip="${escapeHtml(tip)}">${rec} ${MIDDOT} ${sched.gamesLeft}</span>`;
}

// What is printed comes from oddsFigure alone, so an unclinched team can never read 100%. The width is that figure's percent.
function buildPlayoffOddsRowHtml({ teamId, name, abbrev, color, record, figure: f, sched }) {
    const pct = f.pct;
    const figure = f.certain === 'clinched' ? 'Clinched'
        : (f.certain === 'eliminated' ? 'Eliminated'
            : (f.bound === 'over' ? '&gt;99%' : (f.bound === 'under' ? '&lt;1%' : `${f.pct}%`)));
    const isChampion = teamId === AppState.championTeamId;
    return `
        <div class="bar-row-group">
            <div class="bar-row${isChampion ? ' is-champion' : ''}">
                ${buildBarTitleHtml(name, abbrev)}
                <div class="bar-track">
                    <div class="bar-fill" style="width:${pct}%; background:${color};"></div>
                </div>
                <span class="bar-value">${escapeHtml(record)} ${MIDDOT} ${figure}</span>
                ${oddsSchedHtml(sched)}
            </div>
        </div>
    `;
}

// One team's seed-spread row: one segment per seed in seed order, tinted on the heatmap's shared color-mix rule. The likeliest seed's label prints only when there is room.
function buildPlayoffOddsSeedRowHtml({ teamId, name, abbrev, record, seeds, byes, sched }) {
    const isChampion = teamId === AppState.championTeamId;
    let bestIdx = 0;
    seeds.forEach((v, i) => { if (v > seeds[bestIdx]) bestIdx = i; });
    const n = seeds.length;
    const segmentsHtml = seeds.map((v, i) => {
        const pct = v * 100;
        if (pct < 0.05) return '';
        const tint = n > 1 ? (1 - i / (n - 1)) * 100 : 100;
        const label = (i === bestIdx && pct >= 8) ? `${ordinal(i + 1)} ${Math.round(pct)}%` : '';
        return `<div class="bar-segment dr-seed-seg" style="width:${pct}%; --pct:${tint};"`
            + ` data-tooltip="${escapeHtml(`${ordinal(i + 1)} seed: ${pct.toFixed(1)}%`)}">`
            + `${label ? `<span class="dr-seed-seg-label">${escapeHtml(label)}</span>` : ''}</div>`;
    }).join('');
    // The bye mass is the sum of the seats a bracket bye covers; a row under 1% prints nothing.
    const byeMass = byes > 0 ? seeds.slice(0, byes).reduce((s, v) => s + v, 0) * 100 : 0;
    const byeCaption = byeMass >= 1 ? `<span class="dr-bye-caption">bye ${Math.round(byeMass)}%</span>` : '';
    return `
        <div class="bar-row-group">
            <div class="bar-row${isChampion ? ' is-champion' : ''}">
                ${buildBarTitleHtml(name, abbrev)}
                <div class="bar-track">
                    <div class="bar-fill" style="width:100%;">${segmentsHtml}</div>
                </div>
                <span class="bar-value">${escapeHtml(record)}</span>
                ${byeCaption}
                ${oddsSchedHtml(sched)}
            </div>
        </div>
    `;
}

// A roto league's title bar, reusing the solid bar with the title chance and the team's current roto points.
function buildPlayoffOddsTitleRowHtml({ teamId, name, abbrev, color, points, pct }) {
    const isChampion = teamId === AppState.championTeamId;
    return `
        <div class="bar-row-group">
            <div class="bar-row${isChampion ? ' is-champion' : ''}">
                ${buildBarTitleHtml(name, abbrev)}
                <div class="bar-track">
                    <div class="bar-fill" style="width:${pct}%; background:${color};"></div>
                </div>
                <span class="bar-value">${escapeHtml(points)} pts ${MIDDOT} ${pct}% title</span>
            </div>
        </div>
    `;
}

function playoffOddsEmptyMessage(state) {
    if (state === 'too few weeks to resample') return 'Not enough of the season has been played yet for playoff odds.';
    if (state === 'no started-lineup history yet') return 'Playoff odds for a roto league need lineup history the reader has not gathered yet - open the diagnostic panel and run Harvest lineups first.';
    if (state === 'no schedule' || state === 'no rules') return 'Playoff odds are not available for this league.';
    return 'Playoff odds could not be computed for this league.';
}

// The full regular season through the last completed period, never the shared timeframe, since the odds are a full-season fact.
function renderPlayoffOddsGraph(rules) {
    const graph = document.getElementById('left-graph-container');
    const state = playoffOddsState;

    if (!state || state.key !== playoffOddsKey()) {
        graph.innerHTML = buildLoadingHtml();
        return;
    }
    if (state.status === 'loading') {
        graph.innerHTML = buildLoadingHtml();
        return;
    }
    const result = state.result;
    if (!result || result.state) {
        graph.innerHTML = buildEmptyStateHtml(playoffOddsEmptyMessage(result && result.state));
        return;
    }

    // A roto league sorts and labels by its own season standing, since it has no W-L record to read.
    const isRoto = rules.scoring === 'roto';
    // Hoisted above the branch so the row map can reach it; unused on the roto path.
    const resultAt = AppState.isPointsLeague ? (t, w) => t.weeklyMatchResult[w] : (t, w) => t.weeklyMatchWins[w];
    let rows;
    if (isRoto) {
        rows = AppState.teamStats
            .filter(t => AppState.visibleTeams.has(t.id))
            .map(t => ({ id: t.id, name: displayTeamName(t), team: t, sortVal: Number(t.rotoPoints) || 0 }))
            .sort((a, b) => b.sortVal - a.sortVal);
    } else {
        const through = Math.min(AppState.maxCompletedWeek, rules.regSeasonWeeks);
        const sumThrough = (map) => {
            let total = 0;
            for (let w = 1; w <= through; w++) total += (map || {})[w] || 0;
            return total;
        };
        const primaryMap = AppState.isPointsLeague ? 'weeklyMatchResult' : 'weeklyMatchWins';

        // The same rows in the same order as the standings' primary section, so flipping tabs never reorders the league.
        rows = AppState.teamStats
            .filter(t => AppState.visibleTeams.has(t.id))
            .map(t => ({ id: t.id, name: displayTeamName(t), team: t, sortVal: sumThrough(t[primaryMap]) }))
            .sort((a, b) => b.sortVal - a.sortVal);
    }

    if (!rows.length) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // The row builder is chosen by the same league-shape read that gated the tab, never from the odds result, whose seeds are filled for every shape.
    const everyoneSeated = !isRoto && playoffOddsEveryoneSeated(rules);
    const byes = everyoneSeated ? playoffOddsByeCount(rules) : 0;
    // Most to least likely: clinched first, eliminated last, the rest by the unrounded chance so two teams printing the same bound still order.
    if (!isRoto && !everyoneSeated) {
        const tier = r => {
            const o = result.teams[String(r.id)];
            return o?.clinched === true ? 2 : (o?.eliminated === true ? 0 : 1);
        };
        const chance = r => Number(result.teams[String(r.id)]?.odds) || 0;
        rows = [...rows].sort((a, b) => tier(b) - tier(a) || chance(b) - chance(a));
    }
    const schedules = isRoto ? {} : remainingSchedule(AppState.apiData?.schedule || [], rules);
    const rowsHtml = rows.map(r => {
        const odds = result.teams[String(r.id)];
        if (!odds) return '';
        if (isRoto) {
            return buildPlayoffOddsTitleRowHtml({
                teamId: r.id, name: r.name, abbrev: r.team?.abbrev, color: AppState.teamColorMap[r.id],
                points: formatRotoPoints(r.team.rotoPoints), pct: Math.round((odds.titleOdds || 0) * 100)
            });
        }
        const rec = computeRecordByTier(r.team, 1, rules.regSeasonWeeks, resultAt);
        const record = formatRecord(rec.reg);
        if (everyoneSeated) {
            return buildPlayoffOddsSeedRowHtml({
                teamId: r.id, name: r.name, abbrev: r.team?.abbrev, record, seeds: odds.seeds || [], byes,
                sched: schedules[String(r.id)]
            });
        }
        return buildPlayoffOddsRowHtml({
            teamId: r.id, name: r.name, abbrev: r.team?.abbrev, color: AppState.teamColorMap[r.id],
            record, figure: oddsFigure(odds), sched: schedules[String(r.id)]
        });
    }).join('');

    graph.innerHTML = `<div class="std-sections"><div class="std-bars">${rowsHtml}</div></div>`;
    attachDataTooltips(graph);

    // The same no-scroll pass the standings render runs; sizeBarTitles measures whichever title and value classes are on screen.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;
        graph.classList.remove('bars-compact');
        if (graph.scrollHeight > graph.clientHeight + 1) graph.classList.add('bars-compact');
        sizeBarTitles(graph);
        // The schedule column is one measured width for the whole list so every track ends at the same x.
        const cells = [...graph.querySelectorAll('.bar-sched')];
        cells.forEach(c => { c.style.flex = '0 0 auto'; c.style.width = 'auto'; });
        const w = Math.ceil(Math.max(0, ...cells.map(c => c.scrollWidth)));
        graph.style.setProperty('--bar-sched-w', `${w}px`);
        cells.forEach(c => { c.style.flex = ''; c.style.width = ''; });
    });
}

// Roto points arrive as halves whenever ESPN split a category tie, so they need one decimal when they have one and none when they don't ("3.5 pts", "5 pts").
function formatRotoPoints(v) {
    if (v === undefined || v === null) return '-';
    const num = Number(v);
    if (!Number.isFinite(num)) return '-';
    return (num % 1 !== 0) ? num.toFixed(1) : String(num);
}

// Roto Team Rankings: the roto table ordered by ESPN's own season total, rendered as the payload reports it.
function renderRotoStandings() {
    const graph = document.getElementById('left-graph-container');
    graph.innerHTML = '';

    // Full Season shows ESPN's official points verbatim; a recent-window pill re-scores the categories over that window's started days instead.
    const sport = AppState.loadedSport;
    const bounds = activeRotoWindow(sport);
    const win = bounds ? computeRotoWindow(sport, bounds.start, bounds.end) : null;
    const pointsFor = t => win ? (win.pointsByTeam.get(t.id) || 0) : (t.rotoPoints || 0);

    // Filtered by the visible teams like the other boxes; an all-hidden filter shows the shared empty state.
    const leftData = AppState.teamStats
        .filter(t => AppState.visibleTeams.has(t.id))
        .map(t => ({ id: t.id, name: displayTeamName(t), rotoPoints: pointsFor(t), team: t }))
        .sort((a, b) => b.rotoPoints - a.rotoPoints);
    if (leftData.length === 0) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    // Roto has one standings section, and it gets the same flip arrow the head-to-head sections do.
    const face = sectionFace('roto');
    const asPie = face === 'pie';
    const overallMax = Math.max(0, ...leftData.map(tv => tv.rotoPoints));
    // Built only when bars are the body shown, as in renderStandings.
    const barsBody = face !== 'bars' ? '' : leftData.map(tv => buildStandingsBarRowHtml({
        teamId: tv.id, name: tv.name, abbrev: tv.team?.abbrev, color: AppState.teamColorMap[tv.id],
        isLeader: overallMax > 0 && tv.rotoPoints === overallMax,
        // A roto season has no postseason, so the bar is a single regular-season segment.
        split: { reg: tv.rotoPoints, playoff: 0, consolation: 0, total: tv.rotoPoints },
        overallMax, recordByTier: null
    })).join('');

    graph.innerHTML = `
        <div class="std-sections">
            ${buildStandingsSectionHtml({
                key: 'roto',
                // The header names the basis. On projections these are not ESPN's standings, and a box labelled "Roto Points" over figures nobody has earned would be a quiet lie.
                header: projectedBasisOn
                    ? (AppState.isPointsLeague ? 'Projected Points' : 'Projected Roto Points')
                    : 'Roto Points',
                isLast: true, asPie, face, barsBody,
                // Built only when shown, as the pie's body is, so the fit pass never sees tracks beside bars.
                spreadBody: face === 'spread' ? buildCategorySpreadBodyHtml() : '',
                // A roto season has no weekly window to count per matchup against.
                pieBody: asPie ? buildSectionDonutHtml(leftData, 'rotoPoints', { resultAt: null }) : ''
            })}
        </div>`;
    attachDataTooltips(graph);
    wireSectionFlips(graph, renderRotoStandings);

    // The same deferred fit pass the head-to-head standings run.
    const renderId = ++leftColumnRenderId;
    requestAnimationFrame(() => {
        if (renderId !== leftColumnRenderId) return;
        fitStandingsSections(graph);
        sizeStandingsBarTitles(graph);
        observeStandingsFit(graph);
    });
}

// Roto Category Rankings: one block per category, teams ordered by the roto points that category awarded, with the season total behind it.
function renderRotoCategoryGraph() {
    const container = document.getElementById('cat-graph-container');
    container.innerHTML = '';

    // Every category the league has, in role-grouped order, one per screen; there is no selection to restore.
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

    // Full Season reads ESPN's per-category points and values; a window pill re-scores over its started days. The hover names the period.
    const bounds = activeRotoWindow(sport);
    const win = bounds ? computeRotoWindow(sport, bounds.start, bounds.end) : null;
    const period = win ? 'in this timeframe' : 'for the season';
    const valFor = (team, id) => win ? win.catValuesByTeam.get(team.id)?.[id] : team.seasonCats[id];
    const ptsFor = (team, id) => win ? win.pointsByStatByTeam.get(team.id)?.[id] : team.rotoPointsByStat[id];

    // A points league has no roto points to rank by, so it ranks by production, the figure its in-season bar and the heatmap cell already show. The unit is dropped with it.
    const byProduction = projectedBasisOn && AppState.isPointsLeague;

    const blocks = [];

    selectedStats.forEach(stat => {
        const inverse = leagueInverseIds(sport).has(String(stat.id));
        // THE HEATMAP'S OWN isAvg, not this renderer's guess. Its cells call formatCatValue with AVERAGE_STATS membership, which ROUNDS a counting category and keeps three decimals for a rate; without it a derived projection printed "35.303 interceptions" beside a cell reading 35, which is the same bar-and-cell disagreement this whole item exists to end.
        const isAvg = (AVERAGE_STATS[sport] || new Set()).has(String(stat.id));
        // The bar's own quantity, read through one accessor so the sort, length, label and race cannot drift apart.
        const barOf = byProduction ? valFor : ptsFor;
        const teamVals = visibleTeamsList
            .map(team => ({
                id: team.id, name: displayTeamName(team), abbrev: team.abbrev, team,
                val: valFor(team, stat.id),
                pts: barOf(team, stat.id)
            }))
            // A null is not zero on the projected side. Rows with no figure are dropped so a ranked bar of nulls cannot call every team level.
            .filter(tv => byProduction
                ? (tv.pts !== undefined && tv.pts !== null)
                : (tv.val !== undefined || tv.pts !== undefined))
            // Roto points already encode direction, so sorting on them is right in both directions. A raw production figure does not, so an inverse category ranks the LOWEST first, which is exactly what renderCategoryGraph does with the same figure.
            .sort((a, b) => (byProduction && inverse)
                ? (a.pts || 0) - (b.pts || 0)
                : (b.pts || 0) - (a.pts || 0));
        if (teamVals.length === 0) return;

        const maxPts = Math.max(0, ...teamVals.map(tv => tv.pts || 0));
        const minPts = Math.min(...teamVals.map(tv => tv.pts || 0));
        // Just the stat name, since the box is already titled Category Rankings.
        const rowsHtml = [];

        teamVals.forEach(tv => {
            const pts = tv.pts || 0;
            const fillPct = getZoomedFillPct(pts, minPts, maxPts);
            // Exactly one point reads "1 pt", everything else (including a half) takes the plural.
            const unit = pts === 1 ? 'pt' : 'pts';
            const label = byProduction ? `${formatCatValue(pts, isAvg)}` : `${formatRotoPoints(pts)} ${unit}`;
            const tip = byProduction
                ? `${tv.name} · ${stat.name}: ${formatCatValue(pts, isAvg)} ${period}`
                : `${tv.name} · ${stat.name}: ${formatCatValue(tv.val)} ${period}, ${formatRotoPoints(pts)} roto ${unit}`;
            const segments = buildBarSegments(
                { reg: pts, playoff: 0, consolation: 0, total: pts },
                AppState.teamColorMap[tv.id], tip, byProduction ? (v) => formatCatValue(v, isAvg) : formatRotoPoints
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
        // Roto races too. The series walks the same started-day sums the bars are scored from, and is null on a fallback tier whose weekly shape would be wrong.
        blocks.push({
            id: String(stat.id),
            name: stat.name,
            inverse,
            header: buildBlockHeaderHtml(categoryHeaderLabel(sport, stat.id, stat.name)),
            rowsHtml,
            race: buildCategoryRaceSeries(stat.id, teamVals, 0, 0)
        });
    });

    renderCategoryBlocks(container, blocks);
}

// One standings section: its header with the flip arrow and whichever body it is showing. A pie is a section's alternate view, flipped per section.
function buildStandingsSectionHtml({ key, header, isLast, asPie, face: faceIn, barsBody, pieBody, spreadBody }) {
    const face = faceIn || (asPie ? 'pie' : 'bars');
    // The arrow names the next face, which is the whole indicator.
    const next = nextSectionFace(key, face);
    const seam = isLast
        ? 'border-bottom: none; margin-bottom: 0; padding-bottom: 0;'
        // The seam keeps its space and loses its line, so the fit arithmetic is unchanged; the section header's own rule divides the two.
        : 'border-bottom: none; margin-bottom: 4px; padding-bottom: 4px;';
    const label = next === 'bars' ? `Show ${header} as bars`
        : (next === 'pie' ? `Show ${header} as a pie chart` : `Show ${header} as a category spread`);
    const bodyHtml = face === 'pie' ? pieBody
        : (face === 'spread' ? `<div class="std-spread">${spreadBody}</div>` : `<div class="std-bars">${barsBody}</div>`);
    // The spread face says what it is with an info mark and no sentence on the face (docs/VOICE.md).
    const info = face === 'spread'
        ? '<span class="hint" tabindex="0" role="button" aria-label="About the category spread" data-hint="One track per scored category, the weakest team at the left and the best at the right. Your team is ringed; the team just above and just below it in that category are coloured; every other team is a small grey dot.">&#9432;</span>'
        : '';
    return `
        <div class="team-block std-section${face === 'pie' ? ' is-pie' : ''}${face === 'spread' ? ' is-spread' : ''}" style="${seam}">
            ${buildBlockHeaderHtml(face === 'spread' ? 'Category spread' : header, `${info}<button type="button" class="chrome-arrow std-flip" data-section="${escapeHtml(key)}"
                    title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${face === 'pie' ? '&#8249;' : '&#8250;'}</button>`)}
            <div class="std-body">${bodyHtml}</div>
        </div>`;
}

// The spread face's body. category-spread.js does the arithmetic; this passes it what the heatmap reads and places each dot at its position.
function buildCategorySpreadBodyHtml() {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const cats = scoredCategoriesInRange(start, end);
    if (cats.length === 0) return buildEmptyStateHtml('No category data for this timeframe yet.');
    const teams = AppState.teamStats.map(t => ({
        id: t.id,
        totals: Object.fromEntries(cats.map(c => [c.id, aggregateTeamCategory(t, c.id, c.isAvg, start, end)]))
    }));
    // The reader is found on the league's own team list, which carries the owners; teamStats does not.
    const tracks = categorySpread({
        categories: cats.map(c => ({ id: c.id, label: c.name, inverse: c.inverse })),
        teams,
        readerTeamId: findOwnedTeamId(AppState.apiData?.teams || [], AppState.userSwid)
    });
    const teamById = new Map(AppState.teamStats.map(t => [t.id, t]));
    const isAvgOf = new Map(cats.map(c => [c.id, c.isAvg]));
    const nameOf = id => { const t = teamById.get(id); return t ? t.name : String(id); };
    return tracks.map(track => {
        // Dots sharing one exact position are a group, fanned along the track in small steps so none covers another, with one tooltip naming the group.
        const groups = new Map();
        track.dots.forEach(dot => {
            const key = String(dot.at);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(dot);
        });
        const roleRank = { other: 0, above: 1, below: 1, level: 2, reader: 3 };
        const fanOf = new Map();
        const groupTip = new Map();
        groups.forEach(members => {
            if (members.length < 2) return;
            const ordered = [...members].sort((a, b) => (roleRank[a.role] ?? 0) - (roleRank[b.role] ?? 0));
            const n = ordered.length;
            const hasReader = ordered.some(d => d.role === 'reader');
            let k = 0;
            ordered.forEach((d, i) => {
                let fan;
                if (hasReader) fan = d.role === 'reader' ? 0 : (k++) + 2;
                else if (d.at === 0) fan = i;
                else if (d.at === 1) fan = -(n - 1 - i);
                else fan = i - (n - 1) / 2;
                fanOf.set(d, fan);
            });
            const tip = `Tied at ${formatCatValue(ordered[0].value, isAvgOf.get(track.id))}: ${ordered.map(d => nameOf(d.teamId)).join(', ')}`;
            ordered.forEach(d => groupTip.set(d, tip));
        });
        const dots = track.dots.map(dot => {
            const team = teamById.get(dot.teamId);
            const colour = AppState.teamColorMap[dot.teamId];
            const tip = groupTip.get(dot) || `${team ? team.name : dot.teamId} \u00b7 ${track.label}: ${formatCatValue(dot.value, isAvgOf.get(track.id))}`;
            const fan = fanOf.has(dot) ? ` --fan: ${fanOf.get(dot)};` : '';
            return `<span class="spread-dot spread-${escapeHtml(dot.role)}" style="left: ${(2 + dot.at * 96).toFixed(2)}%;${fan}${dot.role === 'other' || !colour ? '' : ` background: ${colour};`}" data-tooltip="${escapeHtml(tip)}"></span>`;
        }).join('');
        return `<span class="spread-label" title="${escapeHtml(track.label)}${track.inverse ? ' (lower is better)' : ''}">${escapeHtml(track.label)}</span><span class="spread-track">${dots}</span>`;
    }).join('');
}

// A section's donut, read off the same sorted teams and value key as its bars so the two views cannot disagree about who leads.
function gamesBehind(teamW, teamL, leaderW, leaderL) {
    return ((leaderW - teamW) + (teamL - leaderL)) / 2;
}

function lastFiveDots(team, startWeek, endWeek, resultAt) {
    const dots = [];
    for (let w = startWeek; w <= endWeek; w++) {
        const val = resultAt(team, w);
        if (val === undefined) continue;
        dots.push(val === 1 ? 'w' : val === 0.5 ? 't' : 'l');
    }
    return dots.slice(-5);
}

// Matchups played, generically, used only by a plain-total section's per-matchup column.
function matchupsPlayed(team, startWeek, endWeek) {
    let n = 0;
    for (let w = startWeek; w <= endWeek; w++) {
        if (team.weeklyMatchWins[w] !== undefined || team.weeklyCatWins[w] !== undefined) n++;
    }
    return n;
}

/**
 * Builds the form half of a team's row tail: a five-dot strip of the latest results and the
 * current win or loss streak.
 * @param {Object} team The team's stats row; an absent team yields an empty string.
 * @param {Object} opts Window and scoring options.
 * @param {number} opts.startWeek First matchup period of the span shown.
 * @param {number} opts.endWeek Last matchup period of the span shown.
 * @param {string} opts.scoring 'points' or 'categories', which decides where a result lives.
 * @param {Function} opts.resultAt Accessor (team, week) returning 1, 0.5, 0 or undefined.
 * @param {Object[]} opts.input The teams passed to movementFor.
 * @param {number} [opts.window] The shared recent window; the streak does not depend on it.
 * @returns {string} The dots and streak pill as HTML, or an empty string without a result accessor.
 */
export function buildFormStreakHtml(team, { startWeek, endWeek, scoring, resultAt, input, window }) {
    if (!resultAt || !team) return '';
    const dots = lastFiveDots(team, startWeek, endWeek, resultAt)
        .map(r => `<span class="brd-dot brd-dot-${r}"></span>`).join('');
    const m = movementFor(input, { teamId: team.id, window: window || 1, scoring });
    // A tie is its own direction and prints no pill.
    const streakHtml = m && m.run && (m.run.dir === 'won' || m.run.dir === 'lost')
        ? `<span class="brd-streak brd-streak-${m.run.dir}">${m.run.dir === 'won' ? 'W' : 'L'}${m.run.length}</span>`
        : '<span class="brd-streak brd-streak-none" aria-hidden="true"></span>';
    return `${dots}${streakHtml}`;
}

// A team's full row tail: the form half plus a rank-move arrow over the shared window. No window pill lit means no arrow.
function buildRowDensityHtml(team, { startWeek, endWeek, scoring, resultAt, input, window }) {
    if (!resultAt || !team) return '';
    const form = `<span class="brd-form">${buildFormStreakHtml(team, { startWeek, endWeek, scoring, resultAt, input, window })}</span>`;
    if (!window) return `<span class="bar-row-density">${form}</span>`;
    const m = movementFor(input, { teamId: team.id, window, scoring });
    const arrowHtml = (!m || !m.delta)
        ? `<span class="brd-arrow brd-flat" title="No change over the last ${window}">&#8212;</span>`
        : (m.delta > 0
            ? `<span class="brd-arrow brd-up" title="Up ${Math.abs(m.delta)} over the last ${window}">&#9650;${Math.abs(m.delta)}</span>`
            : `<span class="brd-arrow brd-down" title="Down ${Math.abs(m.delta)} over the last ${window}">&#9660;${Math.abs(m.delta)}</span>`);
    return `<span class="bar-row-density">${form}${arrowHtml}</span>`;
}

// Category Wins and Points For rows show the last five matchups' category share, or point margins, rather than repeating the match record's dots.
function lastFiveGames(teamId, startWeek, endWeek) {
    const schedule = AppState.apiData?.schedule || [];
    return schedule
        .filter(g => g.matchupPeriodId >= startWeek && g.matchupPeriodId <= endWeek
            && g.winner && g.winner !== 'UNDECIDED' && g.home && g.away
            && (g.home.teamId === teamId || g.away.teamId === teamId))
        .sort((a, b) => a.matchupPeriodId - b.matchupPeriodId)
        .slice(-5);
}

function buildCatShareHtml(teamId, { startWeek, endWeek }) {
    if (startWeek === undefined || endWeek === undefined) return '';
    const games = lastFiveGames(teamId, startWeek, endWeek);
    if (!games.length) return '';
    const marks = games.map(g => {
        const side = g.home.teamId === teamId ? g.home : g.away;
        const tally = matchupTally(side);
        const total = tally ? (tally.wins || 0) + (tally.ties || 0) + (tally.losses || 0) : 0;
        if (!total) return '';
        // Stacked from the mark's floor: the won share, then the tied share above it, with the empty remainder reading as lost.
        const winPct = Math.round((tally.wins / total) * 100);
        const tiePct = Math.round((tally.ties / total) * 100);
        const share = (tally.wins + tally.ties * 0.5) / total;
        const record = tally.ties ? `${tally.wins}-${tally.losses}-${tally.ties}` : `${tally.wins}-${tally.losses}`;
        const tip = `Matchup ${g.matchupPeriodId}: ${record} categories (${Math.round(share * 100)}%)`;
        return `<span class="brs-mark" data-tooltip="${escapeHtml(tip)}">
                <span class="brs-fill brs-fill-win" style="height:${winPct}%;"></span>
                ${tiePct > 0 ? `<span class="brs-fill brs-fill-tie" style="bottom:${winPct}%; height:${tiePct}%;"></span>` : ''}
            </span>`;
    }).join('');
    return `<span class="bar-row-density bar-row-share">${marks}</span>`;
}

// The points-league twin: the last five matchups' MARGIN (this team's points less the opponent's), as small signed bars centred on a zero line, capped at the mark's own half-height so one blowout cannot swallow the row's every other bar into invisibility.
function buildPointsMarginHtml(teamId, { startWeek, endWeek }) {
    if (startWeek === undefined || endWeek === undefined) return '';
    const games = lastFiveGames(teamId, startWeek, endWeek);
    if (!games.length) return '';
    const margins = games.map(g => {
        const mine = g.home.teamId === teamId ? g.home : g.away;
        const theirs = g.home.teamId === teamId ? g.away : g.home;
        return matchupPoints(mine) - matchupPoints(theirs);
    });
    const maxAbs = Math.max(1, ...margins.map(m => Math.abs(m)));
    // The mark is split at its centre line and each bar grows away from it, capped at the half so one blowout cannot cross the line.
    const HALF_PX = 7;
    const marks = games.map((g, i) => {
        const m = margins[i];
        const dir = m > 0 ? 'win' : (m < 0 ? 'loss' : 'tie');
        const barPx = Math.max(m === 0 ? 2 : 1, Math.round((Math.abs(m) / maxAbs) * HALF_PX));
        const tip = `Matchup ${g.matchupPeriodId}: ${m > 0 ? '+' : ''}${m.toFixed(1)} points`;
        const anchor = m >= 0 ? `bottom:50%;` : `top:50%;`;
        const bar = `<span class="brs-margin-bar brs-margin-${dir}" style="${anchor} height:${barPx}px;"></span>`;
        return `<span class="brs-mark brs-mark-margin" data-tooltip="${escapeHtml(tip)}">${bar}</span>`;
    }).join('');
    return `<span class="bar-row-density bar-row-share bar-row-margin">${marks}</span>`;
}

// The per-matchup column is dropped for roto, which has no weekly window to count matchups across.
function buildSectionDonutHtml(teams, valueKey, ctx) {
    const total = teams.reduce((sum, t) => sum + Math.max(0, t[valueKey] || 0), 0);
    if (total <= 0) return buildEmptyStateHtml('No totals to split for this timeframe yet.');

    const { resultAt, startWeek, endWeek } = ctx;
    const hasWeeks = startWeek !== undefined && endWeek !== undefined;
    const leader = teams[0];
    const leaderRecord = resultAt
        ? computeRecordByTier(leader.team, startWeek, endWeek, resultAt)
        : null;
    const leaderTotals = leaderRecord && {
        w: leaderRecord.reg.w + leaderRecord.playoff.w + leaderRecord.consolation.w,
        l: leaderRecord.reg.l + leaderRecord.playoff.l + leaderRecord.consolation.l,
        t: leaderRecord.reg.t + leaderRecord.playoff.t + leaderRecord.consolation.t,
    };

    const columns = resultAt
        ? [{ label: 'Record', align: 'right' }, { label: 'Win %', align: 'right' }, { label: 'Last 5', align: 'left' }, { label: 'Behind', align: 'right' }]
        : hasWeeks
            ? [{ label: 'Total', align: 'right' }, { label: 'Per matchup', align: 'right' }, { label: 'Behind', align: 'right' }]
            : [{ label: 'Total', align: 'right' }, { label: 'Behind', align: 'right' }];
    const dotsColumnIndex = resultAt ? 2 : -1;

    const rows = teams.map(t => {
        const color = AppState.teamColorMap[t.id];
        if (resultAt) {
            const rec = computeRecordByTier(t.team, startWeek, endWeek, resultAt);
            const totals = { w: rec.reg.w + rec.playoff.w + rec.consolation.w, l: rec.reg.l + rec.playoff.l + rec.consolation.l, t: rec.reg.t + rec.playoff.t + rec.consolation.t };
            const games = totals.w + totals.l + totals.t;
            const winPct = games > 0 ? ((totals.w + totals.t * 0.5) / games).toFixed(3) : '-';
            const behind = t.id === leader.id ? '-' : gamesBehind(totals.w, totals.l, leaderTotals.w, leaderTotals.l).toFixed(1);
            return {
                id: t.id, name: displayTeamName(t), abbrev: t.team?.abbrev, color, share: (t[valueKey] || 0) / total,
                cells: [formatRecord(totals), winPct, '', behind],
                dots: lastFiveDots(t.team, startWeek, endWeek, resultAt),
            };
        }
        const behind = t.id === leader.id ? '0.0' : ((leader[valueKey] || 0) - (t[valueKey] || 0)).toFixed(1);
        const cells = hasWeeks
            ? (() => {
                const played = matchupsPlayed(t.team, startWeek, endWeek);
                const perMatchup = played > 0 ? ((t[valueKey] || 0) / played).toFixed(1) : '-';
                return [(t[valueKey] || 0).toFixed(1), perMatchup, behind];
            })()
            : [(t[valueKey] || 0).toFixed(1), behind];
        return { id: t.id, name: displayTeamName(t), abbrev: t.team?.abbrev, color, share: (t[valueKey] || 0) / total, cells };
    });

    const centerSubtitle = resultAt
        ? `${formatRecord(leaderTotals)} · leads`
        : (teams.length > 1 && (leader[valueKey] || 0) > (teams[1][valueKey] || 0)
            ? `leads by ${((leader[valueKey] || 0) - (teams[1][valueKey] || 0)).toFixed(1)}`
            : 'leads');

    return buildRankingsDonutHtml({ rows, columns, dotsColumnIndex, centerSubtitle, size: RANKINGS_DONUT_SIZE }, { escapeHtml });
}

// Fits every standings row into the box so no team hides behind a scrollbar. Ladder in order: one column at natural height, two columns filling down then across, then a shrunk pitch that sheds the value label below the tiny pitch. The pitch is shared across sections so they stay parallel.
let standingsHeldWidths = { sig: null, title: 0, value: 0 };
function sizeStandingsBarTitles(graph) {
    const sig = String(graph.clientWidth);
    const away = !!graph.querySelector('.std-section.is-pie, .std-section.is-spread');
    if (away && standingsHeldWidths.sig === sig) { sizeBarTitles(graph, standingsHeldWidths); return; }
    sizeBarTitles(graph);
    if (!away) standingsHeldWidths = { sig, title: lastBarColumnWidths.title, value: lastBarColumnWidths.value };
}

// A section's share of the box holds across a face change. Each section's bars-state height is remembered per box height, a pie is held to that share, and the fit subtracts the whole share before dividing the rest.
let sectionShares = { sig: -1e9, byKey: new Map() };

// The donut table drops its five-dot column only when the table would otherwise fall under the ring, so a roomier box keeps it.
function fitDonutTables(graph) {
    graph.querySelectorAll('.rkd').forEach(rkd => {
        rkd.classList.remove('rkd-no-dots');
        const svg = rkd.querySelector('.rkd-svg'), side = rkd.querySelector('.rkd-side');
        if (!svg || !side || !rkd.querySelector('.rkd-cell-dots')) return;
        if (side.getBoundingClientRect().top > svg.getBoundingClientRect().top + 2) rkd.classList.add('rkd-no-dots');
    });
}

function fitStandingsSections(graph) {
    fitDonutTables(graph);
    const sections = [...graph.querySelectorAll('.std-section')];
    const keyOf = (sec) => { const b = sec.querySelector('.std-flip'); return b ? b.dataset.section : null; };
    const sig = graph.clientHeight;
    const held = [];
    sections.forEach(sec => {
        sec.classList.remove('is-held');
        sec.style.height = '';
    });
    sections.filter(sec => sec.classList.contains('is-pie')).forEach(sec => {
        const share = Math.abs(sectionShares.sig - sig) <= 3 ? sectionShares.byKey.get(keyOf(sec)) : null;
        if (!share) return;
        sec.classList.add('is-held');
        sec.style.height = `${share}px`;
        held.push(sec);
    });
    fitStandingsSectionsCore(graph, held);
    if (!sections.some(sec => sec.classList.contains('is-pie') || sec.querySelector('.std-spread'))) {
        const byKey = new Map();
        sections.forEach(sec => { const k = keyOf(sec); const h = sec.getBoundingClientRect().height; if (k && h > 0) byKey.set(k, h); });
        if (byKey.size) sectionShares = { sig, byKey };
    }
}

function fitStandingsSectionsCore(graph, heldSections) {
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
        // A section held to its share is spent whole: header, body and seam.
        if (heldSections.includes(sec)) {
            overhead += sec.getBoundingClientRect().height + (parseFloat(cs.marginBottom) || 0);
            return;
        }
        overhead += (head ? head.getBoundingClientRect().height : 0)
            + (parseFloat(cs.marginBottom) || 0)
            + (parseFloat(cs.paddingBottom) || 0)
            + (parseFloat(cs.borderBottomWidth) || 0);
    });
    const slotsFor = cols => rowCounts.reduce((sum, n) => sum + Math.ceil(n / cols), 0);
    // The inter-row gaps are real height, one fewer than the rows in each section's tallest column.
    const gapsFor = cols => barsEls.reduce((sum, _, i) => sum + Math.max(0, Math.ceil(rowCounts[i] / cols) - 1), 0);
    const availFor = (cols, gap) => graph.clientHeight - overhead - STD_FIT_SLACK - gapsFor(cols) * gap;

    // Publishes the rhythm this render shows, measured off two adjacent rows, so the category tab can match the standings tab beside it.
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

    // Rung 1. It already fits in one column, so the rows are left exactly as they render naturally.
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
    const correct = () => {
        for (let guard = 0; guard < 6 && pitch > 1; guard++) {
            // Same rule as the pie trim below, zero rather than "close enough".
            const over = graph.scrollHeight - graph.clientHeight;
            if (over <= 0) break;
            pitch = Math.max(1, pitch - Math.max(1, Math.ceil(over / slotsFor(cols))));
            apply(pitch);
        }
    };
    correct();
    // The correction can cross the tiny line after the gap was chosen, so the gap is re-read off the shipped pitch and the corrective pass runs again.
    if (rowGapFor(pitch) !== gap) {
        gap = rowGapFor(pitch);
        apply(pitch);
        correct();
    }
    publishLadder(gap, pitch);
    fitFormStreak(barsEls);
}

// The streak pill is the form strip's most expendable part, so it shows only where every row keeps a track worth reading beside it, measured by turning it on and taking it off if the narrowest track falls under the floor.
const STD_STREAK_TRACK_FLOOR = 48;
function fitFormStreak(barsEls) {
    const twoCol = barsEls.filter(b => b.classList.contains('std-2col'));
    if (!twoCol.length) return;
    twoCol.forEach(b => b.classList.add('std-streak-fits'));
    const narrowest = Math.min(...twoCol.flatMap(b => [...b.querySelectorAll('.bar-track')].map(t => t.getBoundingClientRect().width)));
    const overflow = twoCol.some(b => [...b.querySelectorAll('.bar-row')].some(r => r.scrollWidth > r.clientWidth + 1));
    if (narrowest < STD_STREAK_TRACK_FLOOR || overflow) twoCol.forEach(b => b.classList.remove('std-streak-fits'));
}

// The head-to-head series matrix, tinted with the heatmap's own tokens and built off h2h-series.js in the row order the caller gives. Empty when there is no series to show.
function buildH2hMatrixHtml(teams) {
    const series = h2hSeriesFor(AppState.apiData);
    if (!series.length || teams.length < 2) return '';

    const label = (t) => t.team?.abbrev || t.name;
    const headCells = teams.map(t => `<th class="h2h-team" title="${escapeHtml(t.name)}">${escapeHtml(label(t))}</th>`).join('');
    const bodyRows = teams.map(row => {
        const cells = teams.map(col => {
            if (col.id === row.id) {
                return `<td class="h2h-cell h2h-diag" title="${escapeHtml(row.name)}"></td>`;
            }
            const rec = h2hCellFor(series, row.id, col.id);
            if (!rec) {
                return `<td class="h2h-cell h2h-empty" data-tooltip="${escapeHtml(`${row.name} vs ${col.name}: never met`)}">&ndash;</td>`;
            }
            // A binary lead, trail or level; the percent only borrows the heatmap's mix expression, so a leading cell paints at full strength.
            const pct = rec.wins > rec.losses ? 100 : rec.wins < rec.losses ? 0 : 50;
            const record = rec.ties > 0 ? `${rec.wins}-${rec.losses}-${rec.ties}` : `${rec.wins}-${rec.losses}`;
            const tip = `${row.name} vs ${col.name}: ${record}`;
            return `<td class="h2h-cell" style="--pct:${percentileVar(pct)};" data-tooltip="${escapeHtml(tip)}">${record}</td>`;
        }).join('');
        return `<tr><th class="h2h-team h2h-row-label" title="${escapeHtml(row.name)}">${escapeHtml(label(row))}</th>${cells}</tr>`;
    }).join('');

    // The matrix keeps a readable cell however many teams there are: past the box's width (or height) it scrolls INSIDE the wrap, never the page. 46px is the label column (.h2h-corner), 44px the narrowest column that holds a four-letter abbreviation at 13px and "10-3-1" below it.
    return `
        <div class="h2h-wrap">
            <table class="h2h-matrix" style="min-width:${46 + teams.length * 44}px">
                <thead><tr><th class="h2h-corner"></th>${headCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>`;
}

// The tab is offered when there is a series to draw: not a roto league (h2hSeriesFor's contract), two teams or more, one decided game.
function h2hTabEligible() {
    if (AppState.isRotoLeague || !AppState.apiData) return false;
    return (AppState.teamStats || []).length >= 2 && h2hSeriesFor(AppState.apiData).length > 0;
}

// The head-to-head tab's body. The whole box is the matrix, rows in the standings' own order with the Data Filters applied. It does not pass through renderStandings, so a single played week still draws it.
function renderH2hTab() {
    const graph = document.getElementById('left-graph-container');
    const last = AppState.maxCompletedWeek || 1;
    const total = (t) => {
        let v = 0;
        for (let w = 1; w <= last; w++) v += AppState.isPointsLeague ? (t.weeklyMatchResult[w] || 0) : (t.weeklyMatchWins[w] || 0);
        return v;
    };
    const teams = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id))
        .map(t => ({ id: t.id, name: displayTeamName(t), team: t, total: total(t) }))
        .sort((a, b) => b.total - a.total);
    if (teams.length === 0) {
        graph.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }
    graph.innerHTML = `<div class="h2h-box">${buildH2hMatrixHtml(teams)}</div>`;
    attachDataTooltips(graph);
}

// Re-runs the standings fit whenever the Rankings box changes size, since the single-frame fit can hold a measurement that is no longer true after a filter bar opens, a pop-out closes or the window resizes. Observing the container cannot feed back, and the fit clears its own output first, so repeating it is a no-op.
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
        sizeStandingsBarTitles(graph);
    });
    standingsFitObserver.observe(graph);
}

// Sizes the team-label column to the longest label on screen rather than a fixed width, so the reclaimed width goes to the tracks. One measurement for the whole container keeps every bar starting at the same x.
const BAR_TITLE_MIN = 34;
const BAR_TITLE_MAX = 140;
const BAR_TITLE_PAD = 8;
const BAR_VALUE_MAX = 90;
const BAR_VALUE_PAD = 4;
// The label and value column widths the last bar view measured, so the OTHER Rankings tab can hold its own columns open to at least the same width when the two are drawing the same league.
const lastBarColumnWidths = { title: 0, value: 0 };

/**
 * Converts one measured content width to the column width published for it: the content plus a
 * pad, clamped to the range the layout can afford. The input must be content, never a column
 * width that was already set.
 * @param {number} contentWidth The measured content width in pixels.
 * @param {Object} [opts] Pad and clamp.
 * @param {number} [opts.pad] Pixels added around the content.
 * @param {number} [opts.min] The smallest width returned.
 * @param {number} [opts.max] The largest width returned.
 * @returns {number|null} The column width, or null when the content width is not a positive number.
 */
export function barColumnWidth(contentWidth, { pad = 0, min = 0, max = Infinity } = {}) {
    const n = Number(contentWidth);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.max(min, Math.min(max, Math.ceil(n) + pad));
}

/**
 * Sizes the label and value columns of a bar container to the widest content on screen and
 * publishes the widths as CSS variables, so every track starts and ends at the same x.
 * @param {Element} container The element holding the bar rows.
 * @param {{title: number, value: number}|null} [floorWidths] Widths another view measured; the
 *   columns are held at least this wide and this call does not publish its own measurement.
 * @returns {void}
 */
export function sizeBarTitles(container, floorWidths = null) {
    const rows = [...container.querySelectorAll('.bar-row')];
    if (rows.length === 0) return;

    let widestLabel = 0;
    container.querySelectorAll('.bar-title').forEach(title => {
        // Whichever of the two labels CSS is currently showing (full name or abbreviation).
        let rowWidest = 0;
        [...title.children].forEach(span => {
            if (span.offsetParent === null && span.offsetWidth === 0) return;
            if (getComputedStyle(span).display === 'none') return;
            // Read with getBoundingClientRect because offsetWidth is rounded before the ceiling downstream can add its margin, which let the paint-time ellipsis clip a label.
            rowWidest = Math.max(rowWidest, span.getBoundingClientRect().width);
        });
        // The champion's crown is a::before outside the measured spans, so its computed width is added for champion rows; a row with no badge adds nothing.
        const row = title.closest('.bar-row');
        if (row && row.classList.contains('is-champion')) {
            const before = getComputedStyle(title, '::before');
            if (before.content && before.content !== 'none') {
                rowWidest += (parseFloat(before.width) || 0) + (parseFloat(before.marginRight) || 0);
            }
        }
        widestLabel = Math.max(widestLabel, rowWidest);
    });
    if (widestLabel) {
        let w = barColumnWidth(widestLabel, { pad: BAR_TITLE_PAD, min: BAR_TITLE_MIN, max: BAR_TITLE_MAX });
        // Only a view measuring purely its own content publishes. A follower that wrote its floored width back would ratchet the column wider and never let it narrow again.
        if (!floorWidths) lastBarColumnWidths.title = w;
        else w = Math.max(w, floorWidths.title || 0);
        container.style.setProperty('--bar-title-w', `${w}px`);
    }

    // The value column is content-sized the same way, and one measured width keeps every track ending at the same x. It is measured under max-content so the width already set cannot be read back and ratchet by the pad on each render.
    const priorValueW = container.style.getPropertyValue('--bar-value-w');
    container.style.setProperty('--bar-value-w', 'max-content');
    let widestValue = 0;
    container.querySelectorAll('.bar-value').forEach(v => {
        if (getComputedStyle(v).display === 'none') return;
        // Sub-pixel again, for the same reason as the title column.
        widestValue = Math.max(widestValue, v.getBoundingClientRect().width);
    });
    if (!widestValue) {
        // Nothing measurable: put back whatever was there rather than leaving the column unbounded.
        if (priorValueW) container.style.setProperty('--bar-value-w', priorValueW);
        else container.style.removeProperty('--bar-value-w');
        return;
    }
    let w = barColumnWidth(widestValue, { pad: BAR_VALUE_PAD, max: BAR_VALUE_MAX });
    if (!floorWidths) lastBarColumnWidths.value = w;
    else w = Math.max(w, floorWidths.value || 0);
    container.style.setProperty('--bar-value-w', `${w}px`);
}

// Wires the per-section flip arrows. Re-attached on every render because the sections are rebuilt.
function wireSectionFlips(graph, rerender) {
    graph.querySelectorAll('.std-flip').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.section;
            const to = nextSectionFace(key, sectionFace(key));
            if (to === 'bars') sectionFaces.delete(key);
            else sectionFaces.set(key, to);
            rerender();
        });
    });
}

// The Season Trends toggles drive two series whose names depend on league type, so only the text node after the swatch is swapped for a points league.
function updateTrendToggleLabels() {
    const catLabel = document.getElementById('toggle-cat')?.parentElement;
    if (catLabel && catLabel.lastChild) catLabel.lastChild.textContent = AppState.isPointsLeague ? 'Points' : 'Cat Wins';
}

// The two trend chips draw lines, which need a minimum number of matchups in the window, so they grey and disable rather than vanish. A roto league's race never read them.
function updateTrendToggleAvailability() {
    const ids = ['toggle-cat', 'toggle-match'];
    let usable = true;
    if (!AppState.isRotoLeague) {
        const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
        usable = (end - start + 1) >= MIN_MATCHUPS_FOR_A_LINE;
    }
    ids.forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.disabled = !usable;
        input.parentElement?.classList.toggle('is-idle', !usable);
    });
}

/**
 * Renders the Season Trends box: the Roto Race for a roto league, the matchup scoreboard when
 * the timeframe is a single matchup, and the trend graph otherwise.
 * @returns {void}
 */
export function renderRightColumn() {
    const container = document.getElementById('line-graph-container');
    container.style.display = 'flex';
    updateTrendToggleLabels();
    updateTrendToggleAvailability();

    if (AppState.isRotoLeague) {
        // The Roto Race: the standings rebuilt over the season from each team's current roster.
        const title = document.getElementById('trends-box-title');
        const tooltip = document.getElementById('trends-box-tooltip');
        if (title) title.textContent = 'Roto Race';
        // The hint's unit follows the axis, which is days at Current.
        const byDay = parseTimeframe(AppState.timeframe).window === 1;
        if (tooltip) tooltip.setAttribute('data-hint', `Each team's cumulative roto points by ${byDay ? 'day across the current week' : 'week'}, rebuilt from its current roster. ESPN keeps no roster history, so past trades shift the line.`);
        renderRotoRaceGraph(container);
        return;
    }

    const { start: startWeek, end: endWeek } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    // Points leagues get the scoreboard too, as their card carries the matchup race.
    const isScoreboard = startWeek === endWeek;
    // The scoreboard shows the matchup being played. On a bare span in a points league it follows the current matchup when that lies past the span's end; a picked matchup or window is the reader's own answer and is never overridden.
    const { window: tfWindow, matchup: tfMatchup } = parseTimeframe(AppState.timeframe);
    const liveInSpan = matchupRangeFor(parseTimeframe(AppState.timeframe).span,
        AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup).live;
    const boardWeek = (isScoreboard && AppState.isPointsLeague && !tfWindow && !tfMatchup
        && liveInSpan && liveInSpan > endWeek) ? liveInSpan : startWeek;
    updateTrendsBoxChrome(isScoreboard, boardWeek);

    if (isScoreboard) {
        renderScoreboardBox(container, boardWeek);
    } else {
        renderTrendGraph();
    }
}

// Swaps the trends box's title and tooltip between its two roles in place, so no layout shifts when the content changes. The scoreboard title names its matchup in the league's own unit.
function updateTrendsBoxChrome(isScoreboard, week = null) {
    const title = document.getElementById('trends-box-title');
    const tooltip = document.getElementById('trends-box-tooltip');
    const named = week ? `${axisUnit().long} ${week} Scoreboard` : 'Matchup Scoreboard';
    if (title) title.textContent = isScoreboard ? named : 'Season Trends';
    if (!tooltip) return;
    // Roto never reaches here, so this covers the matchup box's two roles only.
    tooltip.setAttribute('data-hint', isScoreboard
        ? 'This matchup, category by category. The winning side is bold. Pick a wider timeframe for the season trend.'
        : `${AppState.isPointsLeague ? 'Points' : 'Cat Wins'} and Match Wins over the selected timeframe. The dashed line marks the playoff start. Each point shows its breakdown.`);
}

/**
 * Renders the Category Heatmap band for the current timeframe and visible teams, or an empty
 * state when the sport's categories are not validated.
 * @returns {void}
 */
export function renderHeatmapBand() {
    const container = document.getElementById('heatmap-graph-container');
    if (!container) return;
    // The heatmap IS the categories. With none of this sport's ids validated there is nothing honest to shade, so it says so rather than colouring cells by ids nobody has checked.
    if (!categoriesMapped(AppState.loadedSport)) {
        container.innerHTML = buildEmptyStateHtml(unmappedCategoriesNote(AppState.loadedSport));
        return;
    }
    // Roto reaches the same renderer, so the row cap, sorting and pop-out apply to it unchanged. The cap is an inline-band concern, so the pop-out renders every row.
    renderDominanceHeatmap(container, { capRows: !isHeatmapPoppedOut() });
}

// True while the heatmap band is docked inside its pop-out overlay, which main.js does by moving the real container node.
function isHeatmapPoppedOut() {
    const slot = document.getElementById('heatmap-overlay-chart');
    const container = document.getElementById('heatmap-graph-container');
    return !!(slot && container && slot.contains(container));
}

// The league's scored categories that have data anywhere in a week range, role-grouped, each tagged as a rate or lower-is-better. Grouping matters because numeric key order put the goalie ids ahead of every skater.
function scoredCategoriesInRange(startWeek, endWeek) {
    const sport = AppState.loadedSport;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const avgSet = AVERAGE_STATS[sport] || new Set();
    const invSet = leagueInverseIds(sport);
    // Roto and the projected basis have no weekly spine, so a category has data if any team carries a season figure for it. Without this the band asked the weekly spine and drew an empty state.
    const hasData = id => (projectedBasisOn || AppState.isRotoLeague)
        ? AppState.teamStats.some(t => t.seasonCats[id] !== undefined)
        : AppState.teamStats.some(t => {
            for (let w = startWeek; w <= endWeek; w++) if (t.weeklyCats[w] && t.weeklyCats[w][id] !== undefined) return true;
            return false;
        });
    const ids = Object.keys(statMap)
        .filter(id => AppState.scoredStatIds.has(id))
        .filter(hasData);
    // isSecondary marks the role group a category belongs to, so a consumer can draw the rule between the groups without re-deriving the split.
    const secondaryIds = new Set(splitStatIdsByRole(sport, ids).secondary.map(String));
    return orderStatIdsByRole(sport, ids)
        .map(id => ({ id, name: statMap[id], isAvg: avgSet.has(id), inverse: invSet.has(id), isSecondary: secondaryIds.has(String(id)) }));
}

// A team's value in one category over a week range: summed for counting stats, averaged over played weeks for rates. Undefined when the team has no data in the range.
function aggregateTeamCategory(team, catId, isAvg, startWeek, endWeek) {
    // On the projected basis seasonCats already holds the figure and there are no weeks to aggregate. It sits above the roto branch because it is true of every format.
    if (projectedBasisOn) return team.seasonCats?.[catId];
    if (AppState.isRotoLeague) {
        // Full Season reads the season value ESPN ranks on; a window pill re-derives the category from the window's started-day components, so the heatmap and the windowed standings read the same sums. The startWeek and endWeek passed in do not apply to roto.
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

/**
 * Ranks one team in every scored category over the current timeframe, with the value and the
 * league median beside each rank, using the same aggregation and competition ranking as the
 * heatmap.
 * @param {number|string} teamId The team's id.
 * @returns {{all: Object[], best: Object[], worst: Object[]}} Every ranked category, then the
 *   categories above and below the league midpoint. Each entry has id, name, rank, of, value,
 *   median, isAvg and inverse.
 */
export function teamCategoryProfile(teamId) {
    const { start, end } = getTimeframeBounds(AppState.timeframe, AppState.maxCompletedWeek, AppState.regSeasonWeeks, AppState.currentMatchup);
    const cats = scoredCategoriesInRange(start, end);
    const ranked = cats.map(cat => {
        const vals = AppState.teamStats
            .map(t => ({ id: t.id, v: aggregateTeamCategory(t, cat.id, cat.isAvg, start, end) }))
            .filter(x => x.v !== undefined && x.v !== null);
        const mine = vals.find(x => x.id === teamId);
        if (!mine) return null;
        // Competition ranking, inverse-aware. Better values rank first, ties share a rank.
        const better = vals.filter(x => cat.inverse ? x.v < mine.v : x.v > mine.v).length;
        // The value and median ride beside the rank, computed here from the same values the rank was taken from so they cannot disagree about which teams they came from.
        const sortedVals = vals.map(x => x.v).sort((a, b) => a - b);
        const mid = sortedVals.length / 2;
        const median = sortedVals.length % 2 === 1
            ? sortedVals[Math.floor(mid)]
            : (sortedVals[mid - 1] + sortedVals[mid]) / 2;
        return { id: cat.id, name: cat.name, rank: better + 1, of: vals.length, value: mine.v, median, isAvg: cat.isAvg, inverse: cat.inverse };
    }).filter(Boolean);
    // A category is bleeding when the team sits below the league's midpoint in it and winning when above, expressed as a standing percentile so it means the same at any league size. The median rank counts as neither.
    const pctOf = (r) => (r.of <= 1 ? 50 : ((r.of - r.rank) / (r.of - 1)) * 100);
    const scored = ranked.map(r => ({ ...r, pct: pctOf(r) }));
    const best = scored.filter(r => r.pct > 50).sort((a, b) => a.rank - b.rank);
    const worst = scored.filter(r => r.pct < 50).sort((a, b) => b.rank - a.rank);
    return { all: ranked, best, worst };
}

// Display value for a category cell. Rates keep decimals and counting stats show whole. An infinite rate prints as the symbol, and a non-number prints a dash rather than throwing. isAvg false forces a round, which a projected counting stat needs.
function formatCatValue(v, isAvg = null) {
    if (v === undefined || v === null) return '-';
    const n = Number(v);
    if (!Number.isFinite(n)) return Number.isNaN(n) ? '-' : (n > 0 ? '∞' : '-∞');
    if (isAvg === false) return Math.round(n);
    return (n % 1 !== 0) ? n.toFixed(3) : n;
}

function formatCatScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return Number.isNaN(n) ? '-' : (n > 0 ? '∞' : '-∞');
    return (n % 1 !== 0) ? n.toFixed(1) : n;
}

// The head-to-head scoreboard for a single-matchup timeframe in a category league. Each matchup is a card of the two teams, their category-win score and a per-category breakdown with the winning side emphasized. A card renders when at least one of its teams is visible.
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
        // A card is kept when at least one of its sides is visible.
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
            // A thin rule where the second role group starts, drawn only when a primary-role row precedes it. The list stays one column, since two blocks read as one team owning a group of stats.
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
                <span class="h2h-name" title="${escapeHtml(teamNameTitle(team) || team.name)}">${escapeHtml(displayTeamName(team))}</span>
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

    // No card survived the visible-teams filter, so the empty state is shown instead of a bare grid.
    if (!cards) return '';
    return `<div class="h2h-grid">${cards}</div>`;
}

// The playoff series a matchup card is part of, taken straight from the schedule's tier classification. Round names are not guessed, so only the tier label is shown; the regular season has no strip.
function playoffSeriesLabelHtml(game) {
    const tier = game.playoffTierType;
    if (!tier || tier === 'NONE') return '';
    const isChamp = tier === 'WINNERS_BRACKET';
    return `<div class="h2h-series ${isChamp ? 'h2h-series-champ' : 'h2h-series-conso'}">${isChamp ? 'Championship' : 'Consolation'}</div>`;
}

// A points total in a points league's vocabulary: whole points stay whole and fractions keep one decimal. It avoids formatCatValue, which pads to three decimals and widened the header.
function formatPoints(v) {
    const n = Number(v) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// The matchup race for a points league: two cumulative lines over the matchup's scoring periods with the margin underneath. Days on only one side are unioned and a missing day counts as 0. The chart is a normalized viewBox that stretches to its cell. The pro schedule is fetched here once per league key.
let footballSchedule = { key: null, state: 'idle' };
function ensureFootballSchedule() {
    const key = `${AppState.loadedSport}:${AppState.apiData?.id}:${AppState.apiData?.seasonId}`;
    if (footballSchedule.key === key && footballSchedule.state !== 'idle') return;
    footballSchedule = { key, state: 'loading' };
    fetchProTeamSchedules().then(() => {
        if (footballSchedule.key !== key) return;
        footballSchedule = { key, state: 'done' };
        renderRightColumn();
    });
}

// The game index is built once per pro-schedule payload rather than once per card, keyed on the schedule object's identity.
let footballGameIndex = { schedule: null, index: null };
function gameIndexFor(schedule) {
    if (footballGameIndex.schedule !== schedule) {
        footballGameIndex = { schedule, index: schedule ? buildGamePeriodIndex(schedule) : null };
    }
    return footballGameIndex.index;
}

// Each side's running total by scoring period, the series the race card and its popout both draw; null when neither side has day-by-day scoring.
function matchupRunningTotals(side) {
    const hPts = side.home.pointsByScoringPeriod || {};
    const aPts = side.away.pointsByScoringPeriod || {};
    const periods = [...new Set([...Object.keys(hPts), ...Object.keys(aPts)])]
        .map(Number).sort((a, b) => a - b);
    if (periods.length === 0) return null;

    let hRun = 0, aRun = 0;
    const hSeries = [], aSeries = [];
    periods.forEach(p => {
        hRun += statValue(hPts[p]) || 0;
        aRun += statValue(aPts[p]) || 0;
        hSeries.push(hRun);
        aSeries.push(aRun);
    });
    return { periods, hSeries, aSeries, hRun, aRun };
}

function buildMatchupRaceHtml(home, away, side) {
    // Football's scoring period is the week, so it reads the day-by-day basis from schedule-insight.js instead.
    if (AppState.loadedSport === 'ffl') return buildFootballMatchupRaceHtml(home, away, side);

    const totals = matchupRunningTotals(side);
    if (!totals) return '';
    return matchupRaceChartHtml(home, away, totals.hSeries, totals.aSeries, totals.hRun, totals.aRun, '');
}

// Football's race basis places each player's points on the day the club played. It falls back to the plain scores when either side's total disagrees with ESPN's own, notes points that could not be placed to a day, and reports a week with placeholder kickoffs as not set. The card and its popout share it so the popout never shows less.
function footballRaceBasis(side) {
    const schedule = currentProSchedule();
    if (!schedule) { ensureFootballSchedule(); return { state: 'loading' }; }
    const map = matchupPeriodMap();
    const matchup = Number(side.matchupPeriodId);
    if (!map || !matchup) return { state: 'empty' };
    const periods = periodsOfMatchup(map, matchup);
    if (!periods.length) return { state: 'empty' };

    const gameIndex = gameIndexFor(schedule);
    if (anyTbdKickoff(gameIndex, periods)) return { state: 'tbd' };

    const race = gameDayRace(side.home, side.away, gameIndex, periods);
    // With no scored day it returns the card's empty state, never a flat line at zero.
    if (!race.days.length) return { state: 'empty' };

    const hTotal = matchupPoints(side.home);
    const aTotal = matchupPoints(side.away);
    const reconciled = race.reconciles.home !== false && race.reconciles.away !== false;
    return {
        state: 'ok',
        hSeries: reconciled ? race.home : [hTotal],
        aSeries: reconciled ? race.away : [aTotal],
        hTotal, aTotal,
        days: reconciled ? race.days : [],
        reconciled,
        // Sums figures schedule-insight.js already rounded, rather than rounding a raw total again.
        unplaced: reconciled ? Math.round((race.unplaced.home + race.unplaced.away) * 100) / 100 : 0
    };
}

// True when any game in the matchup's own periods is still an ESPN placeholder date (see footballRaceBasis above).
function anyTbdKickoff(gameIndex, periods) {
    const want = new Set(periods.map(Number));
    for (const g of gameIndex.values()) {
        if (want.has(Number(g.period)) && g.tbd) return true;
    }
    return false;
}

// A game day's label is the weekday of its earliest kickoff, so a reader can tell which day the line climbed.
function raceDayLabel(ms) {
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short' });
}

// Positioned with the chart's own x formula so a label sits under the point it names at any width.
function dayLabelsHtml(days) {
    if (!days || !days.length) return '';
    const spans = days.map((d, i) => {
        const x = days.length === 1 ? 50 : (i / (days.length - 1)) * 100;
        return `<span style="left:${x}%">${escapeHtml(raceDayLabel(d.at))}</span>`;
    }).join('');
    return `<div class="h2h-race-days">${spans}</div>`;
}

function buildFootballMatchupRaceHtml(home, away, side) {
    const basis = footballRaceBasis(side);
    if (basis.state === 'loading' || basis.state === 'empty') return '';
    if (basis.state === 'tbd') {
        return `<div class="h2h-race"><div class="h2h-race-tbd">Kickoffs not set</div></div>`;
    }
    const noteHtml = (basis.reconciled && basis.unplaced > 0)
        ? `<div class="h2h-race-note">${formatPoints(basis.unplaced)} ${basis.unplaced === 1 ? 'point' : 'points'} not placed to a day.</div>`
        : '';
    return matchupRaceChartHtml(home, away, basis.hSeries, basis.aSeries, basis.hTotal, basis.aTotal,
        noteHtml, dayLabelsHtml(basis.days));
}

// The chart and margin line both race bases share: a normalized 0-100 viewBox with preserveAspectRatio="none" so it stretches to whatever cell the grid ladder hands it, and non-scaling-stroke keeps the lines the same weight however far it stretches. A single-point series (one scored day, or the reconciliation fallback) draws at the chart's own centre rather than dividing by a zero-length span.
function matchupRaceChartHtml(home, away, hSeries, aSeries, hTotal, aTotal, noteHtml, daysHtml = '') {
    const peak = Math.max(...hSeries, ...aSeries, 1);
    const pointsFor = (series) => series
        .map((v, i) => `${series.length === 1 ? 50 : (i / (series.length - 1)) * 100},${100 - (v / peak) * 100}`)
        .join(' ');

    const lead = hTotal >= aTotal ? home : away;
    const margin = Math.abs(hTotal - aTotal);
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
            ${daysHtml}
            <div class="h2h-race-margin" title="${escapeHtml(lead.name)}">${escapeHtml(marginText)}</div>
            ${noteHtml}
        </div>`;
}

// The points-league counterpart of the category scoreboard, sharing its card shell and grid so the same column and abbreviation ladder applies.
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
        const hPts = statValue(matchupPoints(g.home)) || 0;
        const aPts = statValue(matchupPoints(g.away)) || 0;

        const headTeam = (team, cls, winning) => `
            <div class="h2h-head-team ${cls}${winning ? ' h2h-head-lead' : ''}">
                <span class="h2h-dot" style="background:${AppState.teamColorMap[team.id]};"></span>
                <span class="h2h-name" title="${escapeHtml(teamNameTitle(team) || team.name)}">${escapeHtml(displayTeamName(team))}</span>
                <span class="h2h-abbr" title="${escapeHtml(team.name)}">${escapeHtml(team.abbrev)}</span>
            </div>`;

        // Each card's race gets a pop-out button when there is a race to enlarge.
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

    // No card survived the visible-teams filter, so the empty state is shown.
    if (!cards) return '';
    return `<div class="h2h-grid">${cards}</div>`;
}

// A card-level pop-out seam. A card registers the visual it drew and gets an id, and the pop-out dispatches on the visual's kind to a full-size renderer. A new kind adds one renderer branch.
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

// One matchup's race at full size, redrawn with axes, day labels and a hover readout on the same padded viewBox geometry as the Roto Race. Football branches off first so the popout shows the same day-by-day race as its card.
function renderMatchupRaceDetail(container, visual) {
    const { home, away, side } = visual;
    if (AppState.loadedSport === 'ffl') { renderFootballMatchupRaceDetail(container, home, away, side); return; }

    const totals = matchupRunningTotals(side);
    if (!totals) {
        container.innerHTML = buildEmptyStateHtml('No day by day scoring for this matchup.');
        return;
    }

    // Days are numbered within the matchup, since the scoring period id is an internal season counter.
    const n = totals.periods.length;
    renderRaceChartDetail(container, home, away, totals.hSeries, totals.aSeries, (i) => `Day ${i + 1}`, (i) => `Day ${i + 1} of ${n}`);
}

// Football's popout reads the same basis through the same helper as the card and labels each point by the weekday of its earliest kickoff.
function renderFootballMatchupRaceDetail(container, home, away, side) {
    const basis = footballRaceBasis(side);
    if (basis.state === 'tbd') {
        container.innerHTML = buildEmptyStateHtml('Kickoffs not set for this matchup yet.');
        return;
    }
    if (basis.state !== 'ok') {
        container.innerHTML = buildEmptyStateHtml('No day by day scoring for this matchup.');
        return;
    }
    const dayLabel = (i) => (basis.days[i] ? raceDayLabel(basis.days[i].at) : '');
    renderRaceChartDetail(container, home, away, basis.hSeries, basis.aSeries, dayLabel, dayLabel);
}

// The shared chart for every points-league sport: axes, hover line, tooltip and legend, parametrized by how a point's index is labelled.
function renderRaceChartDetail(container, home, away, hSeries, aSeries, xLabelOf, tooltipHeaderOf) {
    let hRun = hSeries[hSeries.length - 1] || 0;
    let aRun = aSeries[aSeries.length - 1] || 0;

    const svgWidth = 800, svgHeight = 350, padding = 45;
    const n = hSeries.length;
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

    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i++) {
        if (i % labelStep !== 0 && i !== n - 1) continue;
        svgStr += `<text x="${xAt(i)}" y="${svgHeight - 10}" font-size="12" text-anchor="middle" style="fill:var(--chart-axis)">${escapeHtml(xLabelOf(i))}</text>`;
    }

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
            <span class="card-race-legend-name" title="${escapeHtml(teamNameTitle(team) || team.name)}">${escapeHtml(displayTeamName(team))}</span>
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

        // Best first, so the readout shows who was ahead that day;.tt-rows lets layoutHoverTooltip reflow and clamp it like every other hover.
        const rows = [{ team: home, val: hSeries[i] }, { team: away, val: aSeries[i] }]
            .sort((a, b) => b.val - a.val)
            .map(r => `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="display:inline-block; width:12px; height:12px; background:${AppState.teamColorMap[r.team.id]}; border-radius:2px; flex:0 0 auto;"></span>
                <span style="width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(displayTeamName(r.team))}</span>
                <span style="font-weight:bold; white-space:nowrap;">${formatPoints(r.val)}</span>
            </div>`).join('');
        tooltipEl.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">${escapeHtml(tooltipHeaderOf(i))}</div><div class="tt-rows">${rows}</div>`;
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

/**
 * Reports whether the matchup-card pop-out overlay is open.
 * @returns {boolean} True while the overlay exists and is not hidden.
 */
export function isCardPopoutOpen() {
    const overlay = document.getElementById('card-overlay');
    return !!(overlay && !overlay.hidden);
}

/**
 * Closes the matchup-card pop-out overlay and clears its chart; a no-op when it is not open.
 * @returns {void}
 */
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
/**
 * Wires the overlay's close button once. The per-card buttons are wired on every scoreboard render.
 * @returns {void}
 */
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

// Incremented on every scoreboard render, as a guard against a superseded deferred measurement.
let scoreboardRenderId = 0;

// Renders the matchup scoreboard and picks the arrangement that fills the box. The search is over column count first and density second. The fewest columns that fit at the loosest density win, so type size gives way only when no arrangement holds the full list. The fit test is per card, because.h2h-cats clips and the container itself would always measure as full.
function renderScoreboardBox(container, week) {
    // Both league types share the card shell and the whole layout search; only the card body differs. Visual ids are positional, so the registry is cleared first.
    resetCardVisuals();
    const html = AppState.isPointsLeague ? buildPointsScoreboardHtml(week) : buildH2HScoreboardHtml(week);
    if (!html) {
        // Empty because the week has no matchups or because the filters hid every one; the second case is named.
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

        // Every category row fits its card, the box is not overflowing, and a points card's race fits its fixed height, which the category check alone never noticed.
        const verticalOk = () =>
            container.scrollHeight <= container.clientHeight + 1 &&
            [...grid.querySelectorAll('.h2h-cats')].every(c => c.scrollHeight <= c.clientHeight + 1) &&
            [...grid.querySelectorAll('.h2h-race')].every(r => r.scrollHeight <= r.clientHeight + 1);

        // The card is still readable at this width. The visible label shows in full and the value row does not clip, measured on the elements rather than a minimum width.
        const horizontalOk = () =>
            [...grid.querySelectorAll('.h2h-card')].every(card => {
                const label = card.querySelector(
                    grid.classList.contains('h2h-abbrev') ? '.h2h-abbr' : '.h2h-name');
                const row = card.querySelector('.h2h-cat-row');
                return (!label || (label.clientWidth > 0 && label.scrollWidth <= label.clientWidth + 1))
                    && (!row || row.scrollWidth <= row.clientWidth + 1);
            });

        // One arrangement is tried at three header densities: full names, abbreviations, then abbreviations with a rounded score. These are label fallbacks inside an arrangement, so the cards keep the size the search earned. The score step frees the label's room, since the exact totals remain on the margin line.
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

        // It does not fit, so the largest page that fits at full quality is taken and the arrows reach the rest, rather than falling back to a scroller.
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

// Paints the page slice and its chrome. The arrows are the Category Rankings arrows and wrap, so neither needs a disabled state. No indicator shows when everything fits.
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

// The category heatmap: a teams by categories grid with each cell the team's value over the selected timeframe, shaded by its rank among the visible teams and inverse-aware. capRows false renders every team row, which the pop-out has the height for.
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

    // Aggregates every team's value per category over the range, then ranks per category by competition rank among the teams that have a value; inverse categories rank the lowest best.
    const valByCat = {};
    const pctByCat = {};
    cats.forEach(c => {
        const vByTeam = {};
        teams.forEach(t => {
            const v = aggregateTeamCategory(t, c.id, c.isAvg, start, end);
            // A null is not a figure. It comes from the projected basis, which keeps an unprojectable category's column with nulls, and ranking them would read every one as zero.
            if (v !== undefined && v !== null) vByTeam[t.id] = v;
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

    // Column sort orders rows by the category's raw value, since the shading already says which end is good. A team with no value parks last in both directions, and a sort left from another league is ignored.
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
        // The arrow slot is rendered in every header and only hidden when the column is not the sort, so the label never shifts sideways.
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
            const tip = `${escapeHtml(t.name)} · ${escapeHtml(c.name)}: ${formatCatValue(v, c.isAvg)} (#${info.rank} of ${info.total})`;
            return `<td class="dh-cell${sortedCls}" style="--pct:${percentileVar(info.pct)};" data-tooltip="${escapeHtml(tip)}">${formatCatValue(v, c.isAvg)}</td>`;
        }).join('');
        return `
            <tr>
                <td class="dh-team" title="${escapeHtml(t.name)}">
                    <span class="dh-dot" style="background:${AppState.teamColorMap[t.id]};"></span><span class="dh-team-name">${heatmapTeamLabelHtml(t)}</span>
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
    sizeHeatmapTeamColumn(container);
    sizeHeatmapCategoryColumns(container);
    attachDataTooltips(container);
}

// The row label is the league's own abbreviation with the full name on the cell's title, and the crown rides along as on the bars.
function heatmapTeamLabelHtml(t) {
    const name = t.name || '';
    const crowned = name.endsWith(NAME_CROWN);
    const bare = crowned ? name.slice(0, -NAME_CROWN.length) : name;
    const crownHtml = crowned ? `<span class="bar-title-crown">${NAME_CROWN}</span>` : '';
    return `${escapeHtml(t.abbrev || bare)}${crownHtml}`;
}

// Sizes the team column to the widest label the league carries, by the same measure-then-size pass as the bars, capped so one long abbreviation cannot eat the grid. It is measured off the inner span, which reports its natural width.
const DH_TEAM_MIN = 40;
const DH_TEAM_MAX = 140;
const DH_TEAM_PAD = 22; // the colour dot, its gap, and the cell's right padding

function sizeHeatmapTeamColumn(container) {
    const labels = [...container.querySelectorAll('.dh-team-name')];
    if (!labels.length) return;
    let widest = 0;
    labels.forEach(el => { widest = Math.max(widest, el.getBoundingClientRect().width); });
    if (!widest) return;
    const w = Math.max(DH_TEAM_MIN, Math.min(DH_TEAM_MAX, Math.ceil(widest) + DH_TEAM_PAD));
    container.style.setProperty('--dh-team-w', `${w}px`);
}

// The category columns are sized to what they hold, since a flat width cut the last header and values. It takes the wider of the header at its bold weight with the reserved arrow slot, and the widest value plus cell padding. No floor, so a roomy box still spreads them under a fixed table layout.
function sizeHeatmapCategoryColumns(container) {
    const table = container.querySelector('.dominance-heatmap');
    const heads = table ? [...table.querySelectorAll('th.dh-sortable')] : [];
    if (!heads.length) return;
    const ctx = (sizeHeatmapCategoryColumns.canvas || (sizeHeatmapCategoryColumns.canvas = document.createElement('canvas'))).getContext('2d');
    const hcs = getComputedStyle(heads[0]);
    const fontPx = parseFloat(hcs.fontSize) || 11;
    ctx.font = `800 ${hcs.fontSize} ${hcs.fontFamily}`;
    const trackingPx = (parseFloat(hcs.letterSpacing) || 0);
    const arrowPx = 0.9 * fontPx + 3;   // .dh-arrow's own reserved slot and margin (dashboard.css)
    let headNeed = 0;
    heads.forEach(th => {
        const label = th.childNodes[0] ? th.childNodes[0].textContent.trim().toUpperCase() : '';
        headNeed = Math.max(headNeed, ctx.measureText(label).width + label.length * trackingPx + arrowPx);
    });
    const cells = table.querySelectorAll('td.dh-cell');
    const range = document.createRange();
    let valueNeed = 0;
    cells.forEach(td => { range.selectNodeContents(td); valueNeed = Math.max(valueNeed, range.getBoundingClientRect().width); });
    const tcs = cells.length ? getComputedStyle(cells[0]) : null;
    const tdPad = tcs ? (parseFloat(tcs.paddingLeft) || 0) + (parseFloat(tcs.paddingRight) || 0) : 10;
    const thPad = (parseFloat(hcs.paddingLeft) || 0) + (parseFloat(hcs.paddingRight) || 0);
    // th width is the CONTENT box; the column is that plus the header's padding, and the cell has to fit its value plus its own padding inside that. +2 for the rounding a canvas run carries.
    const w = Math.ceil(Math.max(headNeed, valueNeed + tdPad - thPad)) + 2;
    container.style.setProperty('--dh-cat-w', `${w}px`);
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

// Past this many teams the band stops growing and scrolls internally, so a large league does not squeeze the row above it.
const HEATMAP_MAX_VISIBLE_ROWS = 10;

// Caps the band at the maximum rows by measuring where the last visible row ends. It is applied synchronously so the columns' deferred fits run against the reclaimed height.
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

// intro is the italic line above the bars. The guard token is keyed by container, because two boxes render single-week bars in the same tick and a shared counter cancelled the first one's orientation measurement.
const singleWeekRenderTokens = new WeakMap();

function renderSingleWeekBars(container, week, showCat, showMatch, { intro = 'Single-matchup timeframe selected, so this shows a direct comparison instead of a trend line.' } = {}) {
    const teams = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id));
    if (teams.length === 0) {
        container.innerHTML = buildEmptyStateHtml('Enable at least one team in Data Filters (below the heatmap) to compare.');
        return;
    }

    const rowsFor = (mapKey) =>
        teams.map(t => ({ id: t.id, name: displayTeamName(t), val: t[mapKey][week] || 0, team: t })).sort((a, b) => b.val - a.val);

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
        // A points league's single-week view is Points only, since a Match Wins bar for one game is a degenerate 1 or 0.
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

    // Adaptive orientation. Columns are tried first because they fill both axes, and rows are the fallback. Which side a league falls on is measured by asking each column whether its value label fits, since a name can ellipsize but a number cannot degrade. It re-runs every render.
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
        // Rows, by choice or because the columns were too thin, get the same fit-all ladder as the category blocks and the season standings, so nothing scrolls.
        fitSingleWeekBars(container);
    });
}

// The fit-all ladder applied to the single-matchup blocks: one column at natural height, two columns, then a shrunk pitch until every team is on screen. It shares the standings constants so it reads like the season standings.
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

    // A trend line needs two weeks. Category leagues reach the scoreboard at a single matchup instead, so this branch is reached with one week only by a points league, which keeps the single-week Points bars.
    if (startWeek === endWeek) {
        renderSingleWeekBars(container, startWeek, showCat, showMatch);
        return;
    }

    // The drawing is made in the panel's own size on a phone, so its text is at its natural size and not scaled with the panel; the desktop keeps the fixed drawing the page stretches.
    const phoneBox = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    const fitW = phoneBox ? Math.round(container.clientWidth) : 0;
    const fitH = phoneBox ? Math.round(container.clientHeight) : 0;
    const svgWidth = fitW >= 240 && fitH >= 180 ? fitW : 800;
    const svgHeight = fitW >= 240 && fitH >= 180 ? fitH : 350;
    const padding = 45;

    // Two cumulative series, each with its own toggle, axis and line style. Channel A is the solid line on the left axis and channel B the dashed line on the right. Category leagues plot Cat Wins and Match Wins; points leagues plot Points and Match Wins.
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

    // preserveAspectRatio none stretches the viewBox edge to edge, which the hover-to-week mapping assumes; letterboxing would put the last matchup out of reach.
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
        // Week labels are thinned to a fixed maximum, evenly spaced, always including the last week.
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

    // The line keeps one style throughout, since the dashed Playoffs marker shows where the playoffs start; the week's tier is kept for the tooltip tag.
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

            hoverData[w].push({ name: displayTeamName(t), abbrev: t.abbrev, color, aSum, bSum, yA: yAVal, yB: yBVal, tier });
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

        // The tooltip is a header and one row per team inside.tt-rows so layoutHoverTooltip can reflow it into columns for a large league. Rows are already best first.
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

// The Roto Race: one cumulative roto-points line per team over the season, drawn like renderTrendGraph. The series come from buildRotoRaceSeries, which owns the reconstruction, so this function is presentation only.
function renderRotoRaceGraph(container) {
    const sport = AppState.loadedSport;

    // Every source the race needs is started before deciding what to draw, because buildRotoRaceSeries holds a loading state until they land. Each is a no-op once loaded, in flight or failed, and its completion re-renders this box.
    if (!weeklyDataFailed()) ensureWeeklyDataForRace(sport);
    ensureRosterSnapshotData(sport);
    ensureRosterTransactionData(sport);
    // The race reads pool-derived lines, so drawing it consumes a deferred pool revalidate.
    revalidateStalePoolIfDue();

    const race = buildRotoRaceSeries(sport);

    // One loading line is held until the best expected tier is complete, then exactly one chart, so a cold load does not repaint a different race several times.
    if (race.loading) {
        container.innerHTML = buildLoadingHtml();
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

    // preserveAspectRatio none for the same reason as the trend chart.
    let svgStr = `<svg id="roto-race-svg" width="100%" height="100%" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none" style="display:block; cursor:crosshair; flex:1;">`;
    const formatTick = (val) => val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
    for (let i = 0; i <= 4; i++) {
        const y = padding + (i / 4) * (svgHeight - padding * 2);
        svgStr += `<line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" style="stroke:var(--chart-grid)" />`;
        svgStr += `<text x="${padding - 5}" y="${y + 4}" font-size="12" text-anchor="end" style="fill:var(--chart-axis)">${formatTick(maxPts - (i / 4) * maxPts)}</text>`;
    }
    svgStr += `<line id="roto-hover-line" y1="${padding}" y2="${svgHeight - padding}" stroke-width="1.5" stroke-dasharray="4,2" display="none" pointer-events="none" style="stroke:var(--chart-axis)" />`;

    // At Current the race runs across the week's days, labelled by position in the matchup, which a reader can place where a scoring period id is internal.
    const dayAxis = !!race.dayAxis;
    const labelAt = (wk, i) => dayAxis ? `Day ${i + 1}` : `${axisUnit().short}${wk}`;

    // Thin the x labels to at most ~10 so a full season's weeks don't crowd, always keeping the last.
    const maxLabels = 10;
    const labelStep = Math.max(1, Math.ceil(numPoints / maxLabels));
    weeks.forEach((wk, i) => {
        if (i % labelStep !== 0 && i !== numPoints - 1) return;
        svgStr += `<text x="${xAt(i)}" y="${svgHeight - 10}" font-size="12" text-anchor="middle" style="fill:var(--chart-axis)">${escapeHtml(labelAt(wk, i))}</text>`;
    });

    // hoverData[i] = the standings column at week i, sorted best-first for the tooltip.
    const hoverData = weeks.map(() => []);
    const colorFor = (id) => AppState.teamColorMap[id];
    race.teams.forEach(team => {
        const series = race.seriesByTeam.get(team.id) || [];
        series.forEach((pts, i) => hoverData[i].push({ id: team.id, name: displayTeamName(team), pts, y: yAt(pts) }));
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

        // The same reflow-to-fit treatment as the Season Trends hover. Hidden teams are dropped from the readout, since the Data Filters apply here too.
        let rows = '';
        col.filter(d => AppState.visibleTeams.has(d.id)).forEach(d => {
            rows += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <span style="display:inline-block; width:12px; height:12px; background:${colorFor(d.id)}; border-radius:2px; flex:0 0 auto;"></span>
                <span style="width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(d.name)}</span>
                <span style="font-weight:bold; white-space:nowrap;">${d.pts % 1 !== 0 ? d.pts.toFixed(1) : d.pts}</span>
            </div>`;
        });
        tooltipEl.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">Roto Points Thru ${escapeHtml(dayAxis ? `Day ${i + 1}` : `${axisUnit().long} ${weeks[i]}`)}</div><div class="tt-rows">${rows}</div>`;
        tooltipEl.style.display = 'block';
        layoutHoverTooltip(tooltipEl, e.clientX, e.clientY);
    });

    svgEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
        hoverLine.setAttribute('display', 'none');
    });
}

// Incremented on every category render as a guard against a superseded deferred measurement.
let catGraphRenderId = 0;

// Which category the box is showing, kept as module state because it is pure view position and keyed by stat id, since every re-render rebuilds the list and an index would land on a different category. Only a league switch resets it.
let catViewedStatId = null;

// Which standings sections are drawn as a pie, by section key, since sections flip independently. A section holds a face value, absent meaning bars; the roto box cycles bars, spread, pie. It survives re-renders and only a league switch clears it.
const sectionFaces = new Map();
const sectionFace = key => sectionFaces.get(key) || 'bars';
function nextSectionFace(key, face) {
    if (key === 'roto') return { bars: 'spread', spread: 'pie', pie: 'bars' }[face] || 'bars';
    return face === 'pie' ? 'bars' : 'pie';
}

/**
 * Clears the Rankings box's view state (the viewed category, flipped sections, scoreboard page and
 * measured bar rhythm) when a different league loads.
 * @returns {void}
 */
export function resetRankingsViewState() {
    catViewedStatId = null;
    sectionFaces.clear();
    scoreboardPageIndex = 0;
    // A new league has its own density, so its standard rhythm has to be measured afresh rather than inherited from whatever the last one could afford.
    leagueLadder = null;
}

// The canonical category row pitch lives in CSS as the one pitch everywhere.

// One category's race: each team's cumulative value week by week under its ranking bars, labelled with the week span and each line's end value. It is built from the weekly values for a head-to-head league and from rotoCategorySeries for roto, so the race and the bar agree. It returns null when there is nothing honest to draw, and the bars take the height.
function buildCategoryRaceSeries(catId, teams, startWeek, endWeek) {
    if (AppState.isRotoLeague) {
        const sport = AppState.loadedSport;
        // At Current the week is the window, so the race runs across its days with the same crediting.
        if (parseTimeframe(AppState.timeframe).window === 1) {
            const daily = rotoCategoryDailySeries(sport);
            if (daily) {
                const points = teams.map(t => ({
                    id: t.id,
                    name: t.name,
                    abbrev: t.abbrev || t.team?.abbrev,
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
            abbrev: t.abbrev || t.team?.abbrev,
            values: (series.byTeam.get(t.id) || []).map(v => v[catId])
        })).filter(p => p.values.some(v => v !== undefined));
        if (points.length === 0) return null;
        return { weeks: series.weeks, points };
    }

    // For hockey and baseball the race draws a matchup's days when fewer than two matchups are complete. The daily series has the roto series' shape so its mapping is reused. It applies only to the matchup being played, is null while loading or short, and leaves days with no lineup out rather than drawing zero. Football has one period per matchup, so it has no day race.
    const liveMatchup = Number(AppState.currentMatchup) || 0;
    if (endWeek - startWeek + 1 < MIN_MATCHUPS_FOR_A_LINE && liveMatchup > 0 && liveMatchup - 1 < MIN_MATCHUPS_FOR_A_LINE) {
        const sport = AppState.loadedSport;
        if (sport === 'ffl') {
            if (liveMatchup < 2) return null;
            const wk = [liveMatchup - 1, liveMatchup];
            const pts = teams.map(t => ({
                id: t.id, name: t.name, abbrev: t.abbrev || t.team?.abbrev,
                values: teamCategorySeries(t.team.weeklyCats, wk, catId, sport)
            })).filter(p => p.values.some(v => v !== undefined));
            return pts.length ? { weeks: wk, points: pts } : null;
        }
        ensureMatchupLineups(sport);
        const daily = matchupCategoryDailySeries(sport);
        if (!daily) return null;
        const points = teams.map(t => ({
            id: t.id, name: t.name, abbrev: t.abbrev || t.team?.abbrev,
            values: (daily.byTeam.get(t.id) || []).map(v => v[catId])
        })).filter(p => p.values.some(v => v !== undefined));
        if (!points.length) return null;
        const first = (periodsOfMatchup(matchupPeriodMap(), daily.matchup) || [])[0];
        const dayLabels = first != null ? daily.periods.map(p => Number(p) - Number(first) + 1) : null;
        return { weeks: daily.periods, points, dayAxis: true, dayLabels };
    }

    // A head-to-head category league carries no per-day team values to build a single-matchup race from, since pointsByScoringPeriod is all zeros and the stat totals are per matchup. Building one would need daily roster snapshots, so the bars take the height.
    if (endWeek - startWeek < 1) return null;
    const weeks = [];
    for (let w = startWeek; w <= endWeek; w++) weeks.push(w);
    // teamCategorySeries owns the accumulation, so a rate is recomputed from summed components at every point rather than added up.
    const sport = AppState.loadedSport;
    const points = teams.map(t => ({
        id: t.id,
        name: t.name,
        abbrev: t.abbrev || t.team?.abbrev,
        values: teamCategorySeries(t.team.weeklyCats, weeks, catId, sport)
    }));
    return { weeks, points };
}

// Registry of the race data behind each rendered block, keyed by the block's render id, so the hover handler can answer with exact values without re-deriving anything. Cleared per render.
let catRaceSeq = 0;
const catRaceData = new Map();

// The race markup is a normalized viewBox stretched to its block, with non-scaling strokes. Every label is HTML positioned over the plot, because stretched SVG text would be squashed. Inverse categories are drawn as accumulated, since the bars already say which end is good.
function buildCategoryRaceHtml(series, isInverse) {
    if (!series) return '';
    const { weeks, points } = series;
    const n = weeks.length;
    // A day race counts its own days from one; a week race names the league's real unit. axisUnit is untouched either way. It names matchup and week axes, and Day is neither.
    const dayAxis = !!series.dayAxis;
    const flat = points.flatMap(p => p.values).filter(v => v !== undefined && Number.isFinite(v));
    if (flat.length === 0) return '';
    // The axis fits the plotted range, padded by a tenth of its span, so a rate such as AVG is not squashed into the top of an axis that runs to 0. Zero is the floor only when it falls inside the padded range.
    const rawPeak = Math.max(...flat), rawFloor = Math.min(...flat);
    const rawSpan = (rawPeak - rawFloor) || 1;
    const pad = rawSpan * 0.1;
    const peak = rawPeak + pad;
    let floor = rawFloor - pad;
    // Zero is the floor only for a series that never goes below it; a negative value keeps its own room under the axis.
    if (rawFloor >= 0 && floor <= 0 && peak >= 0) floor = 0;
    const span = (peak - floor) || 1;
    const yPct = (v) => 100 - ((v - floor) / span) * 100;
    const zeroInside = floor < 0 && peak > 0;
    const xPct = (i) => n === 1 ? 50 : (i / (n - 1)) * 100;
    // Three tick labels off the fitted range: floor, mid and peak. The real percentage is kept on a data attribute because the clamp pass later writes pixels into style.top.
    const ticksHtml = [peak, (peak + floor) / 2, floor]
        .map(v => `<span class="cat-race-tick" data-top-pct="${yPct(v).toFixed(2)}" style="top:${yPct(v).toFixed(2)}%;">${escapeHtml(formatCatValue(v))}</span>`)
        .join('');

    // The race indexes the league's own timeline, matchups in head-to-head and weeks in roto.
    const unit = axisUnit();
    const dayNo = (i) => (series.dayLabels && series.dayLabels[i] != null) ? series.dayLabels[i] : i + 1;
    const axisFrom = dayAxis ? `Day ${dayNo(0)}` : `${unit.short}${weeks[0]}`;
    const axisTo = dayAxis ? `Day ${dayNo(n - 1)}` : `${unit.short}${weeks[n - 1]}`;
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

    // The legend names each line by its team colour, built from the same team set as the lines, so anyone with no defined value has neither a line nor an entry.
    const legendHtml = points
        .filter(p => p.values.some(v => v !== undefined))
        .map(p => `<span class="cat-race-legend-item" style="color:${AppState.teamColorMap[p.id]};">${escapeHtml(p.abbrev || p.name)}</span>`)
        .join('');

    return `
        <div class="cat-race" data-race="${id}">
            <div class="cat-race-plot">
                <svg class="cat-race-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${zeroInside ? `<line class="cat-race-zero" x1="0" x2="100" y1="${yPct(0).toFixed(2)}" y2="${yPct(0).toFixed(2)}" vector-effect="non-scaling-stroke" stroke-dasharray="3,3" />` : ''}${polys}</svg>
                <span class="cat-race-hairline" hidden></span>
                ${ticksHtml}
                ${ends}
            </div>
            <div class="cat-race-axis"><span>${axisFrom}</span><span>${axisTo}</span></div>
            ${legendHtml ? `<div class="cat-race-legend">${legendHtml}</div>` : ''}
        </div>`;
}

// Hover on a race shows each team's exact cumulative value at the hovered point, best first, through the shared tooltip layout.
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
            // The viewBox stretches edge to edge, so the cursor ratio maps straight onto the index.
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

            tooltip.innerHTML = `<div class="tt-header" style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:6px; font-size:13px; color:#ddd;">${escapeHtml(raceEl.dataset.cat || '')} thru ${series.dayAxis ? `Day ${(series.dayLabels && series.dayLabels[i] != null) ? series.dayLabels[i] : i + 1}` : `${axisUnit().long} ${series.weeks[i]}`}</div><div class="tt-rows">${rows}</div>`;
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
// Race band heights include the race's own chrome. Below the minimum the band drops the axis and legend and gives those pixels to the plot. The chrome constants were measured live rather than summed from the CSS.
const CAT_RACE_MIN = 97;
const CAT_RACE_FLOOR = 40;
// The block header's full occupied height, margin included, since the margin is as real to the layout as the text. One number, because both tabs share one header.
const CAT_HEADER_H = 28;
const CAT_HEADER_SHRUNK_H = 28;
// The pager's foot row is real in-flow height, reserved whenever the indicator or the Advanced Stats toggle has something to show.
const CAT_PAGER_PAD = 20;
// There is no minimum pitch constant, because clamping the pitch up to a readable floor overflows the box and clips the last team. Under the shrunk pitch the row sheds its value label to the hover and drops to small type.
const CAT_PITCH_SHRUNK = 22;

// Lays out the Category Rankings box. The box shows one category at a time and the arrows cycle the whole list. Every team always fits, and the ladder yields in order: one column at the canonical pitch with the race, two columns, no race, then a shrunk pitch as the last rung.
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

    // The Advanced Stats toggle belongs to the sport, so a league with nothing to add shows no foot row.
    const advancedCount = advancedCategoryCount(AppState.loadedSport);
    const paged = blocks.length > 1;
    const hasFoot = paged || advancedCount > 0;

    // The height budget includes the pager's own chrome, or the block overruns the box by exactly that much.
    const chrome = hasFoot ? CAT_PAGER_PAD : 0;
    const avail = Math.max(0, height - chrome);
    // Gaps between rows are real height, so the race bids against a leftover net of them. The standard gap is whatever the standings tab shows, with only the tiny pitch allowed to undercut it.
    const standardGap = leagueLadder ? leagueLadder.gap : STD_NATURAL_GAP;
    const gapFor = pitch => (pitch < STD_PITCH_TINY ? Math.min(rowGapFor(pitch), standardGap) : standardGap);

    // When the standings tab places the same number of rows, the two tabs draw the same picture, so the category pitch takes the standings' pitch, only ever downward.
    const twinLadder = !!leagueLadder && leagueLadder.rows === rowCount && leagueLadder.pitch > 0;
    const canonicalPitch = twinLadder ? Math.min(CAT_ROW_PITCH, leagueLadder.pitch) : CAT_ROW_PITCH;

    const fitFor = (cols, pitch = canonicalPitch) => {
        const perCol = Math.ceil(rowCount / cols);
        const gap = gapFor(pitch);
        const gaps = Math.max(0, perCol - 1) * gap;
        return { cols, perCol, pitch, gap, leftover: avail - (CAT_HEADER_H + perCol * pitch + gaps) };
    };

    // The ladder in preference order. Fewest columns wins and a full-height race beats a short one, but every rung shows every team. Columns are capped at two, since a third leaves each row too narrow for a name and a bar.
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
        // Nothing holds every team at the canonical pitch, so the pitch yields, so the real track height is divided by the rows. It is floored at 1px only to stay positive, never clamped up to a readable minimum.
        cols = 2;
        showRace = false;
        rowsPerCol = Math.ceil(rowCount / cols);
        const track = avail - CAT_HEADER_SHRUNK_H;
        const gaps = Math.max(0, rowsPerCol - 1);
        // The pitch is solved with the gaps paid for, then once more if it is small enough for the cheaper gap, as the standings fit does.
        gap = standardGap;
        pitch = Math.max(1, Math.floor((track - gaps * gap) / rowsPerCol));
        if (gapFor(pitch) !== gap) {
            gap = gapFor(pitch);
            pitch = Math.max(1, Math.floor((track - gaps * gap) / rowsPerCol));
        }
    }
    // At phone width the rows take their natural height and the panel scrolls inside when the rows and the plot cannot both fit.
    if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) {
        cols = 1;
        rowsPerCol = rowCount;
        showRace = hasRace;
        pitch = CAT_ROW_PITCH;
        gap = standardGap;
    }
    const gridRows = Math.ceil(rowCount / cols);

    catRaceData.clear();
    catRaceSeq = 0;

    // A band under CAT_RACE_MIN goes tight. The week-span axis and the legend both drop (.cat-race-tight) so their pixels go to the plot.
    const tightRace = showRace && chosen && chosen.fit.leftover < CAT_RACE_MIN;
    const raceHtml = showRace ? buildCategoryRaceHtml(block.race, block.inverse) : '';
    const race = raceHtml
        ? raceHtml.replace('<div class="cat-race" ', `<div class="cat-race${tightRace ? ' cat-race-tight' : ''}" data-cat="${escapeHtml(block.name)}" data-inverse="${block.inverse ? 1 : 0}" `)
        : '';
    // cat-2col clamps the team name to its short form. At half width a 140px title would leave the bar track nothing to say (the full name stays on the row's title tooltip either way). cat-shrunk is the sub-canonical pitch, with tighter type, no value labels, tighter header.
    const shrunk = pitch < CAT_ROW_PITCH;
    const rowsCls = 'cat-rows' + (cols > 1 ? ' cat-2col' : '') + (pitch < CAT_PITCH_SHRUNK ? ' cat-rows-tiny' : '');
    const blockCls = 'team-block cat-block' + (shrunk ? ' cat-shrunk' : '');
    const pagerCls = 'cat-pager' + (paged ? ' cat-paged' : '');
    // The foot row is a real flex sibling under cat-fill, never inside it, with its own grid so the page indicator stays centred whatever the toggle's width. It is rebuilt every render.
    const footHtml = hasFoot ? `
            <div class="cat-pager-foot">
                ${paged ? `<div class="cat-page-dots">${viewIndex + 1} / ${blocks.length}</div>` : ''}
                ${advancedCount > 0 ? `
                <div class="cat-pager-foot-toggle advanced-stats-toggle">
                    <label><input type="checkbox" id="cat-advanced-checkbox"${AppState.showAdvancedStats ? ' checked' : ''}> Advanced Stats (${advancedCount})</label>
                </div>` : ''}
            </div>` : '';
    container.innerHTML = `
        <div class="${pagerCls}">
            <div class="cat-fill cat-capped">
                <div class="${blockCls}">
                    ${block.header}
                    <div class="${rowsCls}" style="--cat-pitch:${pitch}px; --cat-row-gap:${gap}px; grid-template-rows: repeat(${gridRows}, ${pitch}px);">${block.rowsHtml.join('')}</div>
                    ${race}
                </div>
            </div>
            ${paged ? `
                <button type="button" class="chrome-arrow cat-page-arrow cat-page-prev" aria-label="Previous category">&#8249;</button>
                <button type="button" class="chrome-arrow cat-page-arrow cat-page-next" aria-label="Next category">&#8250;</button>` : ''}
            ${footHtml}
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

    // The Advanced Stats checkbox is built here because this box's foot row fixes its placement. It stays visible rather than silently following the shared setting, which Player Metrics also writes.
    container.querySelector('#cat-advanced-checkbox')?.addEventListener('change', (e) => {
        AppState.showAdvancedStats = e.target.checked;
        // The cycle just got longer or shorter; renderCategoryBlocks re-resolves the viewed category by stat id, so a full re-dispatch is only to recompute chrome/paging off the new length.
        renderLeftColumn();
    });

    // One measured pass over the end labels only clamps a label inside the plot or hides one that would collide. It never changes a pitch or size, so it cannot move the box.
    const renderId = ++catGraphRenderId;
    requestAnimationFrame(() => {
        if (renderId !== catGraphRenderId) return;
        // The label column is measured here too so the category bars close the same grey channel the standings do. In the twin case the columns hold open to what the standings measured, so tracks end at one x.
        sizeBarTitles(container, twinLadder ? { ...lastBarColumnWidths } : null);
        container.querySelectorAll('.cat-race-plot').forEach(plot => {
            const h = plot.getBoundingClientRect().height;
            if (!h) return;
            // The tick labels take the bars' own 11px label size and the plot gets real left padding, measured off what is on screen, since an integer stat's ticks are half a rate's width.
            const ticks = [...plot.querySelectorAll('.cat-race-tick')];
            if (ticks.length) {
                const widest = Math.max(...ticks.map(t => t.offsetWidth));
                plot.style.paddingLeft = `${Math.ceil(widest) + 4}px`;
            }
            // The peak and floor ticks sit at exactly 0 and 100 percent and are centred on that edge, so each is clamped by half its height as the end labels are.
            ticks.forEach(tick => {
                const half = (tick.offsetHeight || 11) / 2;
                const wanted = (parseFloat(tick.dataset.topPct) / 100) * h;
                tick.style.top = `${Math.max(half, Math.min(h - half, wanted))}px`;
            });
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
    const inverseStatsForSport = leagueInverseIds(sport);

    // Every category the league has, in role-grouped order, one per screen; there is no selection to restore.
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

    // The same row tail Team Rankings shows, off the game record whatever category a block ranks by. It is computed once per team, over the box's own span and the shared window.
    const catRecordScoring = AppState.isPointsLeague ? 'points' : 'categories';
    const catRecordResultAt = AppState.isPointsLeague ? (t, w) => t.weeklyMatchResult[w] : (t, w) => t.weeklyMatchWins[w];
    const catSharedWindow = parseTimeframe(AppState.timeframe).window;
    const catDensityByTeam = new Map(visibleTeamsList.map(team => [team.id, buildRowDensityHtml(team, {
        startWeek, endWeek, window: catSharedWindow,
        scoring: catRecordScoring, resultAt: catRecordResultAt, input: visibleTeamsList
    })]));

    // One ranking block per category; every block is built at full size and only one is shown at a time.
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

            return { id: team.id, name: displayTeamName(team), val: val, team };
        });

        if (inverseStatsForSport.has(stat.id.toString())) {
            // Zero is a real answer for a counting category and the best one, so only a rate drops a team on zero. Dropping on zero removed teams that allowed none once football's ladder categories became inverse. The rate test is the league's own components table.
            teamVals = avgStatsForSport.has(stat.id.toString())
                ? teamVals.filter(tv => tv.val > 0).sort((a, b) => a.val - b.val)
                : teamVals.filter(tv => tv.val !== undefined && tv.val !== null).sort((a, b) => a.val - b.val);
        } else {
            teamVals.sort((a, b) => b.val - a.val);
        }

        if (teamVals.length === 0) return;

        const minVal = Math.min(...teamVals.map(tv => tv.val));
        const maxVal = Math.max(...teamVals.map(tv => tv.val));
        const leaderVal = teamVals[0].val;

        // Just the stat name, since the box is already titled Category Rankings.
        const rowsHtml = [];

        const formatVal = (v) => (v % 1 !== 0) ? v.toFixed(3) : v;

        // The solid-bar decision is per block. If any team's tier component is negative the whole block is solid, so one block never mixes shaded and solid rows.
        const rows = teamVals.map((tv, idx) => ({
            tv, idx, split: splitByTier(tv.team, startWeek, endWeek, w => (tv.team.weeklyCats[w] ? tv.team.weeklyCats[w][stat.id] : 0))
        }));
        const blockHasNegative = rows.some(r => r.split.reg < 0 || r.split.playoff < 0 || r.split.consolation < 0);

        rows.forEach(({ tv, idx, split }) => {
            rowsHtml.push(buildComparisonBarRowHtml({
                name: tv.name, abbrev: tv.team?.abbrev, val: tv.val, color: AppState.teamColorMap[tv.id],
                minVal, maxVal, leaderVal, isLeader: idx === 0, split, formatVal, forceSolid: blockHasNegative,
                density: catDensityByTeam.get(tv.id) || ''
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


// ==== Pre-draft face ====

// labelExtraHtml is markup appended after the escaped label on the same row. It is unescaped by design, so callers pass real markup and never a raw user string.
function predraftCardHtml(label, body, extraClass = '', labelExtraHtml = '') {
    // The label chip is inline-block in one style, so a wrapping flex row is added only when something shares the row.
    const labelHtml = labelExtraHtml
        ? `<div class="pd-card-label-row"><div class="pd-card-label lh-block-head">${escapeHtml(label)}</div>${labelExtraHtml}</div>`
        : `<div class="pd-card-label lh-block-head">${escapeHtml(label)}</div>`;
    return `<div class="pd-card${extraClass ? ' ' + extraClass : ''}">${labelHtml}`
        + `<div class="pd-card-body">${body}</div></div>`;
}

// The countdown. Every figure comes from the league's draft settings through countdownCard, which takes the clock as an argument.
function countdownRegionHtml() {
    const card = countdownCard(AppState.apiData, new Date(), AppState.myTeamId ?? null);
    const when = card.scheduled
        ? new Date(card.date).toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        })
        : 'No date set yet';
    const bits = [];
    // The format is a proper noun that already carries its own Draft, so no second one is appended.
    if (card.type) bits.push(escapeHtml(draftTypeLabel(card.type)));
    // A slot is only a fact once the order exists. Before that it is absent rather than "-".
    if (card.slot && card.teams) bits.push(`you pick ${card.slot} of ${card.teams}`);
    return predraftCardHtml('Draft', `
        <div class="pd-countdown">${escapeHtml(card.phrase)}</div>
        <div class="pd-when">${escapeHtml(when)}</div>
        ${bits.length ? `<div class="pd-quiet">${bits.join(' · ')}</div>` : ''}`);
}

// The lineup ground is drawn by a pure component from the seats the league opens. Every seat is anonymous here because nobody is drafted.
function groundRegionHtml(extraClass = '') {
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const seats = slotSeatsFor({
        counts,
        // The bench and injury codes come from the shared convention rather than the catalog, which names them for football and hockey and not for baseball. Without this the ground drew "16" and "17" beside a My Team that said BE and IL for the same two seats.
        labels: { ...(LINEUP_SLOT_LABELS[sport] || {}), ...nonStartingLabels(sport) },
        order: LINEUP_SLOT_ORDER[sport] || null
    });
    if (!seats.length) return '';
    // Wrapped so the ground can be capped; left alone the diagram scales to the column's full width and pushes the tab into a page scroll.
    return predraftCardHtml('Your starting lineup',
        `<div class="pd-ground">${buildLineupGroundHtml(sport, seats, { escapeHtml })}</div>`, extraClass);
}

// ==== Mock lineup ====

// A noun for the ground's seat hint, kept here because mock-lineup.js has no sport vocabulary. An unknown slot code falls back to its lowercased label.
const MOCK_SEAT_NOUNS = {
    QB: 'quarterback', RB: 'running back', WR: 'receiver', TE: 'tight end', FLEX: 'flex',
    K: 'kicker', 'D/ST': 'defense',
    C: 'center', LW: 'left wing', RW: 'right wing', D: 'defenseman', G: 'goalie', F: 'forward',
    UTIL: 'utility player',
    '1B': 'first baseman', '2B': 'second baseman', '3B': 'third baseman', SS: 'shortstop', OF: 'outfielder',
    P: 'pitcher', SP: 'starter', RP: 'reliever', DH: 'designated hitter'
};
function mockNounFor(label) {
    return MOCK_SEAT_NOUNS[label] || String(label).toLowerCase();
}

// Built once per league, since a mock lineup is a sketch for this draft and rebuilding it on every render would drop what the reader seated.
function ensureMockLineupState() {
    if (AppState.mockLineupState) return;
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const benchLabels = nonStartingLabels(sport);
    // A mock lineup is a projected starting lineup, so the injury seat is never built. The bench seat is kept, and the bench count follows from the seats.
    const nonStarting = new Set([...(NON_STARTING_SLOTS[sport] || new Set())]
        .filter(id => benchLabels[id] !== 'IR' && benchLabels[id] !== 'IL'));
    const seats = mockSeatsFor({
        order: LINEUP_SLOT_ORDER[sport] || [],
        labels: LINEUP_SLOT_LABELS[sport] || {},
        counts,
        nonStarting,
        benchLabels
    });
    AppState.mockLineupState = mockEmptyState(seats);
}

// The seated total prints projected points rather than the edge over replacement, so printedValue needs the points-league flag to choose the right field.
function mockLineupCtx() {
    return { flexPositions: FLEX_SLOT_POSITIONS[AppState.loadedSport] || {}, isPointsLeague: AppState.isPointsLeague };
}

// The pool comes from the real board, not the visible slice. Its rows already carry the value the Projections card prints and are passed through unchanged. Only ranked rows are used, and score rides beside value for points leagues.
function mockLineupPool() {
    return buildBoard()
        .filter(r => r && r.player && r.boardRank && r.value !== null && r.value !== undefined)
        .map(r => ({ id: r.player.id, name: r.player.name, eligiblePositions: r.player.eligiblePositions || [], value: r.value, score: r.score, proTeamId: r.player.proTeamId }));
}

// The ground in mock mode, with every seat addressable, starters and bench. It falls back to the read-only ground when there are no starting seats to mock.
function mockGroundRegionHtml(extraClass = '') {
    ensureMockLineupState();
    const state = AppState.mockLineupState;
    if (!state || !state.seats.length) return groundRegionHtml(extraClass);

    const sport = AppState.loadedSport;
    const pool = mockLineupPool();
    const poolMap = new Map(pool.map(p => [p.id, p]));
    const s = mockSummaryOf(state, pool, lastSeason.card, mockLineupCtx());
    const filled = s ? s.filled : 0;
    const of = s ? s.of : state.seats.filter(seat => !seat.bench).length;
    const benchFilled = s ? s.benchFilled : 0;
    const benchOf = s ? s.benchOf : state.seats.filter(seat => seat.bench).length;

    // The same clubs map the pool card builds, null when the pro schedule has not been fetched yet, in which case a seat shows no club pill.
    const clubs = currentProSchedule() ? buildProTeamAbbrevs(currentProSchedule()) : null;
    const clubOf = (playerId) => {
        if (!clubs) return null;
        const p = poolMap.get(playerId);
        const abbrev = p && p.proTeamId != null ? clubs.get(Number(p.proTeamId)) : null;
        return abbrev ? { name: abbrev } : null;
    };
    const groundHtml = buildMockLineupGroundHtml(sport, state.seats, {
        escapeHtml,
        pool: poolMap,
        targetIndex: AppState.mockLineupTarget,
        formatValue: v => v.toFixed(1),
        nounFor: mockNounFor,
        // A filled seat shows its player's photo through the board's own avatar plumbing, curried with this face's sport.
        avatarHtml: (playerId, name) => buildPlayerAvatarHtml(sport, playerId, name),
        clubOf
    });
    // The header reads the starter and bench counts together, and omits the bench clause for a league with no bench seats.
    const counterText = benchOf
        ? `${filled} of ${of} starters &middot; ${benchFilled} of ${benchOf} bench`
        : `${filled} of ${of} seats filled`;
    // The counter and Clear all are wrapped in one span so they read as one right-side group. The mock team summary is folded into this card as one compact line, so the ground card stays the column's only card.
    const summaryLineHtml = mockTeamSummaryLineHtml(state, s);
    const labelExtraHtml = `<span class="pd-ground-status"><span class="pd-ground-counter">${counterText}</span>`
        + `<button type="button" class="pd-ground-clear" id="mock-clear-all">Clear all</button></span>`;
    return predraftCardHtml('Your starting lineup · mock',
        `<div class="pd-ground pd-ground-mock">${groundHtml}</div>${summaryLineHtml}`, extraClass, labelExtraHtml);
}

// The mock team line: the total, the place, the ceiling and every position figure inline, taking summary() verbatim. Absent when nothing is seated.
function mockTeamSummaryLineHtml(state, s) {
    if (!s || s.filled === 0) return '';

    const totalsHtml = `<span class="pd-mock-figure"><b>${s.total.toFixed(1)}</b> pts &middot; ${s.filled} seat${s.filled === 1 ? '' : 's'}</span>`;
    // The place is absent where the league keeps no points, since ranking a total against zeros would put every mock team first. A place past the field prints as below all of it.
    const placeHtml = s.place
        ? `<span class="pd-mock-figure">${escapeHtml(s.place.place > s.place.of ? `Below all ${s.place.of}` : `#${s.place.place} of ${s.place.of}`)}</span>`
        : '';
    const ceilingHtml = `<span class="pd-mock-figure">Ceiling <b>${s.ceiling.toFixed(1)}</b></span>`;

    // One figure per position, with a warn-toned 0 of N for an unseated one, which is a real figure and not a claim that the position scores zero.
    const figuresHtml = s.byPosition.map(row => {
        const seatCount = state.seats.filter(seat => seat.label === row.label).length;
        const figureHtml = row.filled > 0
            ? `<b>${row.total.toFixed(1)}</b>`
            : `<b class="pd-mock-figure-empty">0 of ${seatCount}</b>`;
        return `<span class="pd-mock-figure">${escapeHtml(row.label)} ${figureHtml}</span>`;
    }).join('');

    // Reuses the compact-line class the per-position row already used.
    return `<div class="pd-mock-figures-line">${totalsHtml}${placeHtml}${ceilingHtml}${figuresHtml}</div>`;
}

// One row of the Projections list, mock-aware. A seated player's row greys with the slot held, and every row is a click and drag source. The targeted seat's eligibility sentence is the row's hover title, since the list says it once under the chips.
function mockPoolRowHtml(r, ctx) {
    const idKey = String(r.id);
    const seatIndex = ctx.seatOf.get(idKey);
    const seated = seatIndex !== undefined;
    let suffixHtml = '';
    let titleAttr = '';
    if (seated) {
        const label = ctx.state.seats[seatIndex].label;
        suffixHtml = ` <span class="pd-pool-mock-note">seated · ${escapeHtml(label)}</span>`;
    } else if (ctx.targetSeat) {
        const player = ctx.poolById.get(idKey);
        if (player && mockCanSeat(player, ctx.targetSeat, ctx.seatCtx)) {
            titleAttr = ` title="${escapeHtml(`→ ${ctx.targetSeat.label} seat`)}"`;
        }
    }
    return `
        <div class="pd-pool-row${seated ? ' pd-pool-row-seated' : ''}" draggable="true" data-player-id="${escapeHtml(idKey)}"${titleAttr}>
            <span class="pd-pool-rank">${r.rank}</span>
            <span class="pd-pool-name"><b>${escapeHtml(r.name)}</b>${suffixHtml}</span>
            <span class="pd-pool-meta">${[r.club, r.pos].filter(Boolean).map(escapeHtml).join(' · ')}</span>
            <span class="pd-pool-value">${r.value === null ? '' : r.value.toFixed(1)}</span>
        </div>`;
}

// The last-season card's data, fetched once per league and remembered with its answer, including the answer that there is nothing.
let lastSeason = { key: null, state: 'idle', card: null };

// An inverse category's fewest or lowest mark, so Best and Weakest never read as a raw-number claim. It is recomputed here because the card module is pure and does not know the current scoring weights.
function categoryInverseIds() {
    return leagueInverseIds(AppState.loadedSport);
}

// The card shows figures over labels, no sentences: champion, finish and record each as a figure with a small label. A points league makes no per-category claim. The card stretches to its row's height, and the standings table lists one row per team in place order with the champion marked by a crown. Logos are omitted because this static template has no avatar fallback wiring.
function standingsRowHtml(row) {
    const record = row.record ? `${row.record.wins}-${row.record.losses}${row.record.ties ? `-${row.record.ties}` : ''}` : '';
    // The record sits beside the points where the format kept both, and the column is blank where it kept neither.
    const points = (row.points === null || row.points === undefined)
        ? '' : row.points.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const figure = [record, points].filter(Boolean).join(' · ');
    const crown = row.isChampion ? '<span class="pd-standings-crown" title="Champion">\u{1F451}</span>' : '';
    const you = row.isYou ? '<span class="pd-standings-you">You</span>' : '';
    // The badge's cell is always the row's third grid child, empty or not, so every row keeps four children and the figure column stays aligned.
    return `<div class="pd-standings-row${row.isYou ? ' pd-standings-row-you' : ''}">
        <span class="pd-standings-place">${row.place != null ? row.place : '-'}</span>
        <span class="pd-standings-name">${crown}${escapeHtml(row.name)}</span>
        <span class="pd-standings-you-cell">${you}</span>
        <span class="pd-standings-figure">${escapeHtml(figure)}</span>
    </div>`;
}

function lastSeasonRegionHtml() {
    if (lastSeason.state !== 'done' || !lastSeason.card) return '';
    const c = lastSeason.card;
    const cell = (figure, label) => `<div class="pd-figure-cell"><div class="pd-figure-lg">${figure}</div><div class="pd-quiet">${escapeHtml(label)}</div></div>`;
    const cells = [];
    if (c.champion) {
        cells.push(cell(c.champion.isYou ? 'You' : escapeHtml(c.champion.name), 'Champion'));
    }
    // A finish of null is a season with no final rank and is said as nothing.
    if (c.finish && c.finish.rank) {
        cells.push(cell(`#${c.finish.rank} of ${c.finish.of}`, 'Your finish'));
        if (c.finish.record) {
            const r = c.finish.record;
            cells.push(cell(`${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`, 'Record'));
        }
    }
    if (c.format !== 'points') {
        const inverseIds = categoryInverseIds();
        const markInverse = (id) => inverseIds.has(String(id)) ? ' (fewest)' : '';
        if (c.best) cells.push(cell(`${escapeHtml(c.best.label)} #${c.best.rank} of ${c.best.of}${markInverse(c.best.id)}`, 'Strongest'));
        if (c.worst) cells.push(cell(`${escapeHtml(c.worst.label)} #${c.worst.rank} of ${c.worst.of}${markInverse(c.worst.id)}`, 'Weakest'));
    }
    if (!cells.length) return '';
    // The standings table fills the card under the figure cells, every team in place order.
    const standingsHtml = (c.standings && c.standings.length)
        ? `<div class="pd-standings">${c.standings.map(standingsRowHtml).join('')}</div>`
        : '';
    return predraftCardHtml(`Last season (${c.year})`,
        `<div class="pd-figures">${cells.join('')}</div>${standingsHtml}`, 'pd-card-tall');
}

// Kicks the one history request the card needs, once per league, and re-renders when it lands. Failure is not an error surface: the card is absent, which is what a league with no readable past looks like anyway.
function ensureLastSeason(key) {
    if (lastSeason.key === key && lastSeason.state !== 'idle') return;
    lastSeason = { key, state: 'loading', card: null };
    loadMostRecentPastSeason().then(payload => {
        if (lastSeason.key !== key) return;
        const summary = payload ? summarizeSeason(payload) : null;
        const sport = AppState.loadedSport;
        // The user's own team, by the same SWID match My Team and the draft room use. A league the user only spectates matches nothing, and the card then reports the champion without claiming a finish for a franchise that is not theirs.
        const teams = AppState.apiData?.teams || [];
        const mineId = findOwnedTeamId(teams, AppState.userSwid);
        const me = teams.find(t => t.id === mineId) || null;
        lastSeason = {
            key,
            state: 'done',
            card: summary ? lastSeasonCard(summary, payload, me ? franchiseKeyOf(me) : null, {
                statMap: ESPN_STAT_MAPS[sport] || {},
                inverseIds: leagueInverseIds(sport)
            }) : null
        };
        renderPreDraftFace();
    }).catch(() => {
        if (lastSeason.key === key) lastSeason = { key, state: 'done', card: null };
    });
}


// The position chip row above the Projections list: All plus each starting slot's label, deduplicated, in the league's own ground order. UTIL is never a chip, since a utility seat takes any skater or batter and would filter nothing.
function mockPoolPositionOptions(sport) {
    const order = LINEUP_SLOT_ORDER[sport] || [];
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const seen = new Set();
    const out = [];
    order.forEach(id => {
        const label = labels[id];
        if (label && label !== 'UTIL' && !seen.has(label)) { seen.add(label); out.push(label); }
    });
    return out;
}

// A row matches a chip when the player is eligible for it. FLEX is a slot's accepted set, so the chip matches the union of every slot sharing that label.
function mockPoolPositionFilterFn(sport, label) {
    if (label === 'ALL') return () => true;
    const order = LINEUP_SLOT_ORDER[sport] || [];
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const flexTable = FLEX_SLOT_POSITIONS[sport] || {};
    const flexIds = order.filter(id => labels[id] === label && flexTable[id]);
    if (flexIds.length) {
        const allowed = new Set();
        flexIds.forEach(id => (flexTable[id] || new Set()).forEach(p => allowed.add(p)));
        return (r) => (r.player?.eligiblePositions || []).some(p => allowed.has(p));
    }
    return (r) => (r.player?.eligiblePositions || []).includes(label);
}

function mockPoolChipsHtml(sport, active) {
    const options = ['ALL', ...mockPoolPositionOptions(sport)];
    return `<div class="pd-pool-chips">${options.map(opt => {
        const label = opt === 'ALL' ? 'All' : opt;
        return `<button type="button" class="pd-pool-chip${opt === active ? ' on' : ''}" data-pool-position="${escapeHtml(opt)}">${escapeHtml(label)}</button>`;
    }).join('')}</div>`;
}

// The row list alone, split out so the search input can rebuild just this in place without re-rendering the face out from under the cursor. It recomputes the board and filter each call, since only the query changes between keystrokes.
function poolRowsHtml() {
    const sport = AppState.loadedSport;
    const rows = buildBoard();
    if (!rows.length) return { rowsHtml: '', targetSeat: null };

    // The chip filters which rows show, never the depth analysis. UTIL is not a rendered chip but stays a valid filter value, reachable by picking a UTIL seat.
    const activeFilter = (mockPoolPositionOptions(sport).includes(AppState.mockPoolPositionFilter) || AppState.mockPoolPositionFilter === 'UTIL')
        ? AppState.mockPoolPositionFilter : 'ALL';
    const filteredRows = activeFilter === 'ALL' ? rows : rows.filter(mockPoolPositionFilterFn(sport, activeFilter));

    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    // Flex seats are data from the state module, so the depth analysis has no opinion about any sport's slots.
    const depth = positionDepth(rows, {
        counts,
        labels: LINEUP_SLOT_LABELS[sport] || {},
        bench: NON_STARTING_SLOTS[sport] || new Set(),
        flex: FLEX_SLOTS[sport] || new Set(),
        teams: Number(AppState.apiData?.settings?.size) || (AppState.apiData?.teams || []).length || 0
    });

    // The list scrolls inside the card, so the limit is the whole filtered board.
    const card = rankedPoolCard(filteredRows, depth, {
        limit: Math.max(filteredRows.length, 1),
        clubs: currentProSchedule() ? buildProTeamAbbrevs(currentProSchedule()) : null
    });
    if (!card) return { rowsHtml: '', targetSeat: null };

    // The search composes with the chip and the seat and narrows the same rows. It matches names only, because club is set only once the pro schedule is loaded, which this face does not fetch. It is left out of the depth analysis, a whole-board question.
    const searchQuery = (AppState.mockPoolSearchQuery || '').trim().toLowerCase();
    const searchedRows = searchQuery
        ? card.rows.filter(r => (r.name || '').toLowerCase().includes(searchQuery))
        : card.rows;

    // Mock-aware rows when there is a mock lineup. The target seat is read before the row list and stands even when a search hides every eligible row.
    const state = AppState.mockLineupState;
    const targetIndex = AppState.mockLineupTarget;
    const targetSeat = (state && targetIndex !== null && targetIndex !== undefined) ? state.seats[targetIndex] : null;
    let rowsHtml;
    if (!searchedRows.length) {
        rowsHtml = `<div class="pd-pool-empty">No one in this pool matches that.</div>`;
    } else if (state) {
        const seatOf = new Map();
        state.seats.forEach((s, i) => { if (s.playerId !== null && s.playerId !== undefined) seatOf.set(String(s.playerId), i); });
        const poolById = new Map(mockLineupPool().map(p => [String(p.id), p]));
        const rowCtx = { state, seatOf, targetSeat, poolById, seatCtx: mockLineupCtx() };
        rowsHtml = searchedRows.map(r => mockPoolRowHtml(r, rowCtx)).join('');
    } else {
        rowsHtml = searchedRows.map(r => `
            <div class="pd-pool-row">
                <span class="pd-pool-rank">${r.rank}</span>
                <span class="pd-pool-name">${escapeHtml(r.name)}</span>
                <span class="pd-pool-meta">${[r.club, r.pos].filter(Boolean).map(escapeHtml).join(' · ')}</span>
                <span class="pd-pool-value">${r.value === null ? '' : r.value.toFixed(1)}</span>
            </div>`).join('');
    }
    return { rowsHtml, targetSeat, activeFilter, sport };
}

function rankedPoolRegionHtml() {
    const { rowsHtml, targetSeat, activeFilter, sport } = poolRowsHtml();
    if (!rowsHtml) return '';

    // The card ends at its last row. The depth sentence and the pointer line were removed because they told the reader what a figure meant or what to do, and the drop-off model they read is gone from the engine.
    const chipsHtml = mockPoolChipsHtml(sport, activeFilter);
    // A targeted seat is named once under the chip row rather than on every eligible row; the same sentence stays as each row's hover title.
    const targetNoteHtml = targetSeat
        ? `<div class="pd-pool-target-note">Picking for the ${escapeHtml(targetSeat.label)} seat &middot; click a row</div>`
        : '';
    // The search value carries the current query across a re-render. Typing itself never re-renders the face, since it is wired debounced and in place.
    const searchHtml = `<input type="text" class="pd-pool-search" data-pool-search
        placeholder="Search players&hellip;" autocomplete="off" value="${escapeHtml(AppState.mockPoolSearchQuery || '')}">`;
    return predraftCardHtml('Projections',
        `${searchHtml}${chipsHtml}${targetNoteHtml}<div class="pd-pool">${rowsHtml}</div>`, 'pd-card-tall');
}


// ==== Post-draft projected face ====

/**
 * Builds every team's roster as player objects from the ids the league payload carries, reading
 * both the team-attached roster and the matchup-side roster, with the team-attached one winning.
 * A team whose roster the payload does not carry is absent from the result rather than empty.
 * @returns {Object<string, Object[]>} Players by team id.
 */
export function draftedRostersByTeam() {
    const byId = new Map((AppState.playerData || []).map(p => [p.id, p]));
    const entriesByTeam = new Map();

    ((AppState.apiData || {}).schedule || []).forEach(game => {
        ['home', 'away'].forEach(side => {
            const s = game[side];
            const entries = ((s || {}).rosterForCurrentScoringPeriod || {}).entries;
            if (s && entries && entries.length) entriesByTeam.set(s.teamId, entries);
        });
    });
    (AppState.apiData?.teams || []).forEach(t => {
        const entries = (t.roster && t.roster.entries) || [];
        if (entries.length) entriesByTeam.set(t.id, entries);
    });

    const out = {};
    entriesByTeam.forEach((entries, teamId) => {
        const players = entries.map(e => byId.get(e.playerId)).filter(Boolean);
        if (players.length) out[teamId] = players;
    });
    return out;
}

/**
 * Gathers what the projected-basis engines need from the loaded league: the sport, the scored
 * category ids, the rate components and the inverse ids.
 * @returns {{sport: string, categoryIds: string[], components: Object[], inverseIds: Set<string>}}
 */
export function projectedContext() {
    const sport = AppState.loadedSport;
    const categoryIds = [...(AppState.scoredStatIds || [])];
    const components = RATE_COMPONENTS[sport] || [];
    const inverseIds = leagueInverseIds(sport);
    return { sport, categoryIds, components, inverseIds };
}
// Your draft, graded: projected placing, the position group breakdown in the profile ribbon's palette and the reader's own picks by round against the board, on one card sized to what they need rather than stretched to fill the trends slot.
function draftGradedHtml() {
    const teams = AppState.apiData?.teams || [];
    const mineId = findOwnedTeamId(teams, AppState.userSwid);
    const standings = (AppState.teamStats || [])
        .map(t => ({ teamId: t.id, points: t.rotoPoints || 0 }))
        .sort((a, b) => b.points - a.points);
    const place = mineId == null ? null : placeOf(standings, mineId);

    // The slot always carries a card. When it cannot be filled it says what it would show and where that comes from, so a missing capture is not mistaken for a missing feature.
    if (!place) {
        return predraftCardHtml('Your Draft',
            '<div class="pd-quiet">This card grades YOUR team: where the draft projects it to '
            + 'finish, the categories it came out strongest and weakest in, and every pick it made '
            + 'against the board. It needs the league opened while signed in, so the extension can '
            + 'tell which team is yours.</div>', 'pd-card-grade');
    }

    // The placing is the card's headline figure: a small label over a large gold number.
    const lines = [
        '<div class="pd-quiet">Projected</div>',
        `<div class="pd-figure-lg">#${place.place} of ${place.of}</div>`
    ];
    if (AppState.isPointsLeague) {
        // A points league shows its projected total and the gap to the team just ahead, or the lead over second place when first. The neighbour is found by nearest points, since a tie shares one place and indexing standings by place would not reliably be the reader's row.
        const myPoints = place.points;
        const ahead = standings.filter(r => r.points > myPoints).sort((a, b) => a.points - b.points)[0];
        const behind = standings.filter(r => r.points < myPoints).sort((a, b) => b.points - a.points)[0];
        let gapHtml = '';
        if (ahead) {
            gapHtml = ` <span class="pd-quiet">&middot; ${(ahead.points - myPoints).toFixed(1)} behind #${place.place - 1}</span>`;
        } else if (behind) {
            gapHtml = ` <span class="pd-quiet">&middot; ${(myPoints - behind.points).toFixed(1)} ahead of #2</span>`;
        }
        lines.push(`<div class="pd-line"><span class="pd-pool-value">${myPoints.toFixed(1)}</span> projected points${gapHtml}</div>`);
        // The position bars use the rank palette every other rank in the app draws in, each with a rank chip, since bar length said how many points but never whether that was good.
        lines.push(pointsByPositionHtml(mineId));
    } else {
        // Strongest and weakest read off the same projected values every other box is drawn from, so the card cannot disagree with the heatmap sitting under it.
        const { sport, categoryIds, inverseIds } = projectedContext();
        const statMap = ESPN_STAT_MAPS[sport] || {};
        // The ranking itself is pure and unit-tested (projectedCategoryRanks); this only hands it the projected values every other box on the face is drawn from.
        const valuesByTeam = {};
        (AppState.teamStats || []).forEach(t => { valuesByTeam[t.id] = t.seasonCats || {}; });
        const ranked = projectedCategoryRanks(valuesByTeam, mineId, categoryIds, inverseIds);
        if (ranked.length) {
            // R1/item 2: "Thinnest" is gone (VOICE.md's ban); the inverse gets the same "(fewest)" mark the last-season card carries, so a category where LOW is good never reads as strong or weak off its raw number alone.
            const name = (r) => `${escapeHtml(statMap[r.id] || r.id)} #${r.rank}${inverseIds.has(String(r.id)) ? ' (fewest)' : ''}`;
            lines.push(`<div class="pd-quiet">Strongest: ${name(ranked[0])} · Weakest: ${name(ranked[ranked.length - 1])}</div>`);
            // A category league's breakdown is the full ranked list the strongest and weakest line summarizes, as a chip row off the same ranking the heatmap reads.
            lines.push(`<div class="pd-cat-chips">${ranked.map(r => `<span class="pd-cat-chip${r.rank <= Math.ceil(ranked.length / 2) ? ' pd-cat-chip-good' : ' pd-cat-chip-bad'}">${name(r)}</span>`).join('')}</div>`);
        }
    }
    const body = `<div class="pd-draft-left">${lines.join('')}</div>${draftPicksColumnHtml(mineId)}`;
    return predraftCardHtml('Your Draft', `<div class="pd-draft-body">${body}</div>`, 'pd-card-grade');
}

// A points league's breakdown: projected points by position as a bar list in the rank palette, each with a chip naming where it stands against the other teams at that position. It sums ESPN's applied total by the player's primary position and orders by the reader's own points.
function pointsByPositionHtml(mineId) {
    if (mineId == null) return '';
    const rosters = draftedRostersByTeam();
    const roster = rosters[mineId];
    if (!roster || !roster.length) return '';
    const sumsFor = (players) => {
        const sums = new Map();
        players.forEach(p => {
            const label = p.positionName || 'Other';
            sums.set(label, (sums.get(label) || 0) + (Number(p.projectedAppliedTotal) || 0));
        });
        return sums;
    };
    const mine = sumsFor(roster);
    const rows = [...mine.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '';
    // Every other team's sum at the same position is computed once, and a team with no roster is left out of the comparison, the same no figure, no rank rule as the category ranking.
    const otherSums = Object.entries(rosters)
        .filter(([teamId]) => String(teamId) !== String(mineId))
        .map(([, players]) => sumsFor(players));
    const max = rows[0][1] || 1;
    const barsHtml = rows.map(([label, pts]) => {
        const others = otherSums.map(s => s.get(label)).filter(v => v !== undefined);
        const of = others.length + 1;
        const better = others.filter(v => v > pts).length;
        const rank = better + 1;
        const t = of > 1 ? (rank - 1) / (of - 1) : 0;
        return `
        <div class="pd-slot-bar-row">
            <span class="pd-slot-bar-label">${escapeHtml(label)}</span>
            <div class="pd-slot-bar-track"><div class="pd-slot-bar-fill" style="width:${Math.max(3, (pts / max) * 100)}%;--pd-rk-t:${t}" title="#${rank} of ${of}"></div></div>
            <span class="pd-slot-bar-value">${pts.toFixed(1)}</span>
            <span class="pd-slot-bar-rank" style="--pd-rk-t:${t}">#${rank}</span>
        </div>`;
    }).join('');
    return `<div class="pd-slot-bars">${barsHtml}</div>`;
}

// The reader's own picks in one column beside the position breakdown: every pick by round with its position and how far it beat or trailed the board, the best value starred. Two sub-columns share the card's height.
function draftPicksColumnHtml(mineId) {
    // The picks live in the roster-transaction harvest, which the Roto Race fills once per session. Reading them costs no request, and without the harvest there are no picks.
    const picks = draftPicksFor();
    if (!picks || !picks.length) {
        // Still in flight, or genuinely absent (a league fetched without a draft, a format that has none). The column says what is missing rather than leaving the card's right half quiet with no reason given.
        return '<div class="pd-draft-picks"><div class="pd-quiet">Reading the draft...</div></div>';
    }
    const board = buildBoard();
    const rankById = new Map(board.filter(r => r.boardRank).map(r => [r.player.id, r.boardRank]));
    const rows = draftPickRows(picks, rankById, mineId);
    if (!rows.length) {
        return '<div class="pd-draft-picks"><div class="pd-quiet">No picks of yours to grade.</div></div>';
    }
    const playersById = new Map((AppState.playerData || []).map(p => [p.id, p]));
    const rowHtml = (row) => {
        const player = playersById.get(row.playerId);
        const name = player ? player.name : `Player ${row.playerId}`;
        const pos = player ? (player.positionDisplay || player.positionName || '') : '';
        const edgeHtml = row.edge === null
            ? '<span class="pd-pick-edge"></span>'
            : `<span class="pd-pick-edge ${row.edge >= 0 ? 'pd-pick-up' : 'pd-pick-dn'}">${row.edge > 0 ? '+' : ''}${row.edge}</span>`;
        return `<div class="pd-pick-row${row.best ? ' pd-pick-best' : ''}">`
            + `<span class="pd-pick-round">${row.round ?? ''}</span>`
            + `<span class="pd-pick-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`
            + `<span class="pd-pick-pos">${escapeHtml(pos)}</span>`
            + edgeHtml
            + '</div>';
    };
    // The header reads Board, since the longer label wrapped at the column's width. The sign is explained by the header's title and by a caption under the table.
    const SIGN_EXPLAINER = "+N: taken N picks after the board's rank · -N: before it";
    const head = `<div class="pd-pick-head"><span>Rd</span><span>Pick</span><span></span>`
        + `<span title="${escapeHtml(SIGN_EXPLAINER)}">Board</span></div>`;
    // Roughly half the picks in each column, with the first column taking the extra row on an odd count, so a long draft reads as one glance.
    const mid = Math.ceil(rows.length / 2);
    const col1 = rows.slice(0, mid);
    const col2 = rows.slice(mid);
    const colHtml = (rows) => `<div>${head}${rows.map(rowHtml).join('')}</div>`;
    return `<div class="pd-draft-picks"><div class="pd-pick-cols">${colHtml(col1)}${col2.length ? colHtml(col2) : ''}</div>`
        + `<div class="pd-pick-caption">${escapeHtml(SIGN_EXPLAINER)}</div></div>`;
}

// The basis switch, not a second page. The tab keeps its own boxes and only the numbers change, filled from rosters times projected lines, so a projected standing is drawn by the same code a played one is.
let projectedBasisOn = false;
// The trends box's own markup, kept from before the graded card took its place so a league that has played can have its chart back. Null means the card has never been drawn.
let trendsBoxMarkup = null;

// Puts the trends box back the way the page shipped it, so the chart's own container exists again by the time renderRightColumn looks for it by id. A re-render after the draft picks land is the case that found this; a league switched from a preseason one to a played one is the case that would have kept an empty box forever.
function restoreTrendsBox() {
    if (trendsBoxMarkup === null) return;
    const trends = document.querySelector('#view-team .col-trends');
    if (trends) trends.innerHTML = trendsBoxMarkup;
    trendsBoxMarkup = null;
}

// Fills teamStats with projected figures and says whether it did. teamStats is DERIVED state, rebuilt by processCoreData on every league fetch, so writing into it here is filling in what the payload has no answer for rather than overwriting anything the league reported.
/**
 * Fills the team stats with projected figures when the league has drafted but not played.
 * @returns {boolean} True when the projected basis is now on, false when the league is in another
 *   season state or its payload carries no rosters.
 */
export function prepareProjectedBasis() {
    projectedBasisOn = false;
    if (seasonState(AppState.apiData) !== SEASON_STATE.PRESEASON) return false;

    const rosters = draftedRostersByTeam();
    // NO ROSTERS, NO PROJECTION. A drafted league whose payload carries no rosters cannot be projected, and the tab's own empty states say that better than a face with nothing in it.
    if (!Object.keys(rosters).length) return false;

    const { categoryIds, components, inverseIds } = projectedContext();
    // Category Rankings reads availableStatsSet rather than seasonCats, which a preseason league has empty, so the cycle list would have nothing to cycle. The heatmap asks teamStats directly and never noticed.
    categoryIds.forEach(id => AppState.availableStatsSet.add(String(id)));
    const sums = projectedTeamSums(rosters, { categoryIds, components });
    const values = projectedValues(sums, categoryIds, components);
    const standings = AppState.isPointsLeague
        ? projectedPointsStandings(rosters)
        : projectedRotoStandings(values, categoryIds.map(id => ({ id, inverse: inverseIds.has(String(id)) })), rotoPointsForCategory);
    const pointsByTeam = new Map(standings.map(r => [String(r.teamId), r.points]));
    // projectedRotoStandings already computes the per-category split, so it is kept rather than only the total. A points league has none, which reads as nothing to show.
    const byCategoryByTeam = new Map(standings.map(r => [String(r.teamId), r.byCategory || {}]));

    (AppState.teamStats || []).forEach(t => {
        const row = values[t.id] || values[String(t.id)] || {};
        t.seasonCats = {};
        // Every scored category keeps its key, null where the projections cannot speak to it, because dropping the key dropped the whole heatmap column. Null is never zero, which in an inverse category would be the best in the league.
        categoryIds.forEach(id => {
            const v = row[id];
            t.seasonCats[id] = (v === undefined ? null : v);
        });
        t.rotoPoints = pointsByTeam.get(String(t.id)) || 0;
        t.rotoPointsByStat = byCategoryByTeam.get(String(t.id)) || {};
    });

    projectedBasisOn = true;
    return true;
}

// The masthead tag and the graded card, put into the tab AFTER its normal boxes have rendered. The graded card takes the Season Trends slot, which is the one box with nothing honest to draw: it is a WEEKLY chart and a preseason league has no weeks.
/**
 * Adds the projected face's masthead tag and graded draft card to the tab after its normal boxes
 * have rendered; a no-op when the projected basis is off.
 * @returns {void}
 */
export function decorateProjectedFace() {
    if (!projectedBasisOn) return;
    const view = document.getElementById('view-team');
    const host = document.getElementById('predraft-face');
    if (!view || !host) return;

    host.style.display = '';
    // The pd-mast-only class pins the host to its content height. Sharing the face's flex-grow rule with the layout made both compete for leftover height and left a blank band.
    host.classList.add('pd-mast-only');
    host.innerHTML = `
        <div class="pd-mast">
            <span class="pd-tag">PRESEASON · PROJECTED</span>
        </div>`;

    // The face's one request. The picks are not in the league payload and only the roto race fetched them. It fires only in preseason, key-guarded, and the response is shared with the Draft tab and the race.
    ensureDraftPicks(AppState.loadedSport);

    // The trends box keeps its slot and size and only its occupant changes. Its markup is kept first, because replacing it destroys the chart container and the next render would throw.
    const trends = view.querySelector('.col-trends');
    if (trends) {
        if (trendsBoxMarkup === null) trendsBoxMarkup = trends.innerHTML;
        trends.innerHTML = draftGradedHtml();
        // The card's height is real only after this frame's layout, so the fit runs in the next frame.
        const card = trends.querySelector('.pd-card-grade');
        if (card) requestAnimationFrame(() => fitDraftPicksColumn(card));
    }
}

// The picks list takes the room, growing its row height from 20px toward a 26px cap while the bars and placing stay as they render. One measured pass then a bounded correction, since the estimate was taken with the old row height painted.
function fitDraftPicksColumn(card) {
    const cols = [...card.querySelectorAll('.pd-pick-cols > div')];
    if (!cols.length) return;
    card.style.removeProperty('--pd-pick-row-h');
    const rowCounts = cols.map(c => c.querySelectorAll('.pd-pick-row').length);
    if (rowCounts.some(n => n === 0)) return;
    // The column with FEWER rows is the one with room to spend on each row; the column with MORE rows (draftPicksColumnHtml gives the first column the extra round on an odd split) is what the 1280x800 cap below is protecting from overflow, since both columns share one row height.
    const maxRows = Math.max(...rowCounts);
    const avail = Math.min(...cols.map(c => c.clientHeight));
    const head = cols[0].querySelector('.pd-pick-head');
    const headH = head ? head.getBoundingClientRect().height : 0;
    let rowH = Math.max(20, Math.min(26, Math.floor((avail - headH) / maxRows)));
    const apply = h => card.style.setProperty('--pd-pick-row-h', `${h}px`);
    apply(rowH);
    for (let guard = 0; guard < 6 && rowH > 20; guard++) {
        const over = Math.max(...cols.map(c => c.scrollHeight - c.clientHeight));
        if (over <= 0) break;
        rowH -= 1;
        apply(rowH);
    }
}

/**
 * Renders the Team Metrics tab in whichever face the league is in: the pre-draft face, the
 * projected face over the normal boxes, or the played season's boxes.
 * @returns {void}
 */
export function renderTeamMetricsTab() {
    // Before a draft the tab flips basis entirely, since the normal boxes have no games to chart and rendering into a hidden layout would measure zero heights.
    if (renderPreDraftFace()) return;
    if (!AppState.apiData) return;
    // Drafted but not played, so the boxes stay and only the numbers change, so teamStats is filled with projected figures and the ordinary renders draw them. The tag and trends swap come afterwards, once geometry is real.
    restoreTrendsBox();
    prepareProjectedBasis();
    renderLeftColumn();
    renderRightColumn();
    renderHeatmapBand();
    decorateProjectedFace();
    syncTrendFilterAvailability();
}

// The trend toggles control a chart that is not there on the projected face, so they are greyed with the reason.
function syncTrendFilterAvailability() {
    const disabled = projectedBasisOn;
    const reason = 'No weekly trend yet - every figure on this page is a projection.';
    ['toggle-cat', 'toggle-match'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.disabled = disabled;
        const label = input.closest('label');
        if (label) label.title = disabled ? reason : '';
    });
}

// The pool list scrolls inside a fixed-height card, which needs no measurement.

// Click a seat then a row, or drag a row onto a seat, delegated on the two containers since the face re-renders on every change. Every mutation goes through mock-lineup.js and re-renders through the one entry point. Picking a seat also sets the position filter to match it, and clearing the target restores All.
function setMockLineupTarget(idx) {
    AppState.mockLineupTarget = idx;
    const seat = (idx !== null && idx !== undefined) ? AppState.mockLineupState?.seats[idx] : null;
    AppState.mockPoolPositionFilter = seat ? seat.label : 'ALL';
}

// The club-colour edge is sampled after render and never blocks it; the plain accent edge shows until the sample resolves. There is no contrast floor, since the edge carries no text.
async function dyeMockSeatClubs(container) {
    const sport = AppState.loadedSport;
    const seats = [...container.querySelectorAll('.lg-mseat-filled[data-club]')];
    if (!seats.length) return;
    await Promise.all(seats.map(async (seat) => {
        const url = proTeamLogoUrl(sport, seat.dataset.club);
        if (!url) return;
        const sampled = await sampleLogoColour(url);
        // The element may have been re-rendered during the await, so a detached node is skipped.
        if (!sampled || !seat.isConnected) return;
        seat.style.setProperty('--card-dye', toCssRgb(sampled));
    }));
}

function wireMockLineup(container) {
    const groundEl = container.querySelector('.pd-ground');
    const poolEl = container.querySelector('.pd-pool');
    const chipsEl = container.querySelector('.pd-pool-chips');
    const clearBtn = container.querySelector('#mock-clear-all');

    // A filled seat's photo is the same avatar markup every other surface uses, so the same load wiring applies. It is idempotent per image.
    if (groundEl) wirePlayerAvatars(groundEl);
    // The club-colour edge is fired and forgotten, since the seat is already correct before the sample resolves.
    if (groundEl) dyeMockSeatClubs(groundEl);

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (!AppState.mockLineupState) return;
            AppState.mockLineupState = mockClear(AppState.mockLineupState);
            setMockLineupTarget(null);
            renderPreDraftFace();
        });
    }

    // The search box filters in place, because a full render per keystroke would recreate the input under the cursor. poolRowsHtml is the same function the full render calls, so the list cannot differ.
    const searchEl = container.querySelector('[data-pool-search]');
    if (searchEl && poolEl) {
        let debounceId = null;
        searchEl.addEventListener('input', () => {
            AppState.mockPoolSearchQuery = searchEl.value;
            clearTimeout(debounceId);
            debounceId = setTimeout(() => {
                poolEl.innerHTML = poolRowsHtml().rowsHtml;
                // The dragstart listeners are bound per element, so they are re-attached after the rows are replaced; the click handler is delegated and needs none.
                poolEl.querySelectorAll('[data-player-id]').forEach(rowEl => {
                    rowEl.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', rowEl.getAttribute('data-player-id'));
                        e.dataTransfer.effectAllowed = 'copy';
                    });
                });
            }, 200);
        });
    }

    // Picking a chip re-renders the face with the list filtered. The seat target survives the filter.
    if (chipsEl) {
        chipsEl.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-pool-position]');
            if (!chip) return;
            AppState.mockPoolPositionFilter = chip.getAttribute('data-pool-position');
            renderPreDraftFace();
        });
    }

    if (groundEl) {
        groundEl.addEventListener('click', (e) => {
            const removeEl = e.target.closest('[data-seat-remove]');
            if (removeEl) {
                if (!AppState.mockLineupState) return;
                const idx = Number(removeEl.getAttribute('data-seat-remove'));
                AppState.mockLineupState = mockUnseat(AppState.mockLineupState, idx);
                if (AppState.mockLineupTarget === idx) setMockLineupTarget(null);
                renderPreDraftFace();
                return;
            }
            // A filled seat is still a click target, which is how seating into an occupied seat replaces it from the ground side.
            const seatEl = e.target.closest('[data-seat-index]');
            if (!seatEl) return;
            const idx = Number(seatEl.getAttribute('data-seat-index'));
            setMockLineupTarget(AppState.mockLineupTarget === idx ? null : idx);
            renderPreDraftFace();
        });
        groundEl.addEventListener('dragover', (e) => {
            if (e.target.closest('[data-seat-index]')) e.preventDefault();
        });
        groundEl.addEventListener('drop', (e) => {
            const seatEl = e.target.closest('[data-seat-index]');
            if (!seatEl || !AppState.mockLineupState) return;
            e.preventDefault();
            const idx = Number(seatEl.getAttribute('data-seat-index'));
            const playerId = e.dataTransfer.getData('text/plain');
            if (!playerId) return;
            AppState.mockLineupState = mockSeat(AppState.mockLineupState, playerId, idx, mockLineupPool(), mockLineupCtx());
            setMockLineupTarget(null);
            renderPreDraftFace();
        });
    }

    if (poolEl) {
        poolEl.addEventListener('click', (e) => {
            const rowEl = e.target.closest('[data-player-id]');
            if (!rowEl) return;
            const target = AppState.mockLineupTarget;
            if (target === null || target === undefined || !AppState.mockLineupState) return;
            const playerId = rowEl.getAttribute('data-player-id');
            AppState.mockLineupState = mockSeat(AppState.mockLineupState, playerId, target, mockLineupPool(), mockLineupCtx());
            setMockLineupTarget(null);
            renderPreDraftFace();
        });
        poolEl.querySelectorAll('[data-player-id]').forEach(rowEl => {
            rowEl.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', rowEl.getAttribute('data-player-id'));
                e.dataTransfer.effectAllowed = 'copy';
            });
        });
    }
}

/**
 * Renders the pre-draft face when the league has not drafted, hiding the tab's other boxes.
 * @returns {boolean} True when the pre-draft face was drawn and the caller should skip the normal boxes.
 */
export function renderPreDraftFace() {
    const host = document.getElementById('predraft-face');
    const view = document.getElementById('view-team');
    if (!host || !view) return false;
    // Clears a stale mark from the projected face's last render, since this face takes the whole view.
    host.classList.remove('pd-mast-only');

    // Every sibling is hidden, not just the layout, since the heatmap band and filters bar are siblings of it. Only what this function hid is restored, so an open overlay is not closed by a blanket reset.
    const hideSiblings = () => [...view.children].forEach(el => {
        if (el === host || el.style.display === 'none') return;
        el.dataset.pdHidden = '1';
        el.style.display = 'none';
    });
    const restoreSiblings = () => view.querySelectorAll('[data-pd-hidden]').forEach(el => {
        el.style.display = '';
        delete el.dataset.pdHidden;
    });

    if (seasonState(AppState.apiData) !== SEASON_STATE.PRE_DRAFT) {
        host.style.display = 'none';
        host.innerHTML = '';
        restoreSiblings();
        return false;
    }

    hideSiblings();
    ensureMockLineupState();
    // What sits under the lineup decides its size, so the right card is built first and the ground knows whether it shares the column. The mock team summary is one line inside the ground card, so the column's card does not change as a seat fills.
    const rightCardHtml = lastSeasonRegionHtml();
    host.style.display = '';
    // Two independent flex columns rather than a 2x2 grid, which coupled the columns' row heights and stranded space under the shorter card.
    host.innerHTML = `
        <div class="pd-mast">
            <span class="pd-tag">PRESEASON · DRAFT NOT HELD</span>
        </div>
        <div class="pd-grid">
            <div class="pd-col pd-col-left">
                ${countdownRegionHtml()}
                ${rankedPoolRegionHtml()}
            </div>
            <div class="pd-col pd-col-right">
                ${mockGroundRegionHtml(rightCardHtml ? '' : 'pd-card-fill')}
                ${rightCardHtml}
            </div>
        </div>`;
    wireMockLineup(host);
    ensureLastSeason(`${AppState.loadedSport}:${AppState.apiData?.id}:${AppState.apiData?.seasonId}`);
    return true;
}
