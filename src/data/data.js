/**
 * Turns the raw league payload into the application's state: the sport, the season's bounds, the
 * league's scoring, each team's weekly categories, results and tiers, and then redraws every view.
 *
 * It reads the payload defensively throughout, since ESPN's fantasy API is unofficial and any
 * field can be absent.
 *
 * @module data
 */
import { AppState, TEAM_COLORS, SECONDARY_LINEUP_SLOTS } from './state.js';
import { seasonState, isPreseason } from './season-state.js';
import { rebuildTimeframeOptions, buildTeamFilterChips, buildNicknamesSheet, collapseSettingsBar, refreshMyTeamTabAvailability, refreshDraftTabAvailability } from '../views/controls.js';
import { renderTeamMetricsTab, resetRankingsViewState } from '../views/graphs.js';
import { resetLeaderboardWeeklyFetchState, normalizePlayerViewStateForLeague, prefetchPlayerData, refreshOpenPlayerDetail, revalidateStalePoolIfDue } from '../views/players.js';
import { noteSeasonSeen, seasonsSeenFor, statValue, unwrapStats, firstDefined, escapeHtml, axisUnit, numericStat, resetLeagueViews, revalidateLeagueViews, renderActiveLeagueView, yearDropdownFor, matchupTally, matchupPoints, readsAsPlayedMatchup, matchupCatsForSide, matchResultOf, leagueTypeBadge } from '../views/utils.js';

// ESPN's own game ids, which say what sport a payload is. A payload with any other id falls back to the sport chosen in the form.
const GAME_ID_SPORTS = { 1: 'ffl', 2: 'flb', 4: 'fhl' };

// Publishes the loaded sport to CSS, which is how a theme picks its shapes for the sport. It is the league's answer and never a setting. Before any league loads the attribute is absent.
function setSportAttribute() {
    document.documentElement.setAttribute('data-sport', AppState.loadedSport);
}

/**
 * Processes the league payload held in the application's state and redraws.
 *
 * It has two callers. A fetch is a new league, year or sport, so everything a previous league left
 * behind is reset: the pool, the caches, the selection and each tab's own state. A revalidate is
 * the same league read again a moment later, so only the figures are recomputed and the views
 * redrawn; resetting there would close what the reader has open for a score that moved.
 *
 * @param {object} [options]
 * @param {boolean} [options.revalidate=false] True for the same league read again.
 * @returns {void}
 */
export function processCoreData({ revalidate = false } = {}) {
    if (!AppState.apiData) return;
    document.getElementById('results').style.display = 'flex';
    // With data in, the setup fields are tucked away. Not on a revalidate: the bar may be open because the reader opened it, and a background refresh should not close a panel under the cursor.
    if (!revalidate) collapseSettingsBar();

    // First, because everything below describes the league now loading and must read its sport from here. The game id is the payload's own answer, so a restored session and a fresh fetch agree. The form is only the fallback for a payload with no game id.
    AppState.loadedSport = GAME_ID_SPORTS[AppState.apiData.gameId]
        || document.getElementById('sport').value
        || 'flb';
    setSportAttribute();

    if (!revalidate) {
        // A fresh league, year or sport invalidates the loaded player pool. It is fetched again the next time it is wanted.
        AppState.playerData = [];
        AppState.playerDataLoaded = false;
        // A previous league's pool failure says nothing about this one, and the reader may have logged in since.
        AppState.playerDataError = null;
        AppState.playerWeeklyCache = {};
        // The pro schedule belongs to one sport and year. It is cleared so a league nobody is looking at does not keep its schedule in memory.
        AppState.proTeamSchedules = null;
        AppState.selectedPlayerId = null;
        // A compare group is built against this league's own pool. A player id carried into another league means another player, or nobody.
        AppState.playerCompareGroupIds = [];
        // A forward look is tied to this league's own matchups, so it does not carry over.
        AppState.ahead = null;
        AppState.showEmptyNights = false;
        // A sketch for this league's draft, which should not survive into another league.
        AppState.mockLineupState = null;
        AppState.mockLineupTarget = null;
        AppState.mockPoolPositionFilter = 'ALL';
        AppState.mockPoolSearchQuery = '';
        // A failed weekly-stats fetch from a previous league or season should not block this one from trying.
        resetLeaderboardWeeklyFetchState();
        // Where the Rankings box was looking is not data. The viewed category and any section turned to a pie belong to the league that was on screen.
        resetRankingsViewState();
        // Every tab that keeps state per league is cleared in one call. Each tab registers its own reset, so this call never needs editing when a tab is added.
        resetLeagueViews();
    }
    // A timeframe left over from a previous season is handled below, where the options are rebuilt with the default forced once this season's own playoffs are known.

    const data = AppState.apiData;
    const teams = data.teams || [];
    const schedule = data.schedule || [];

    // The end of the regular season, the champion and the last completed week are found in one pass over the schedule. The regular season ends the period before the earliest game tagged as a playoff. The champion is the winner of the winners' bracket game in the latest playoff week, and the candidate is cleared whenever a later week's game is found, so a final still in progress crowns nobody.
    let firstPlayoffWeek = null;
    let finalPlayoffWeek = null;
    let champGame = null;
    AppState.maxCompletedWeek = 1;
    schedule.forEach(game => {
        if (game.playoffTierType && game.playoffTierType !== 'NONE') {
            if (firstPlayoffWeek === null || game.matchupPeriodId < firstPlayoffWeek) {
                firstPlayoffWeek = game.matchupPeriodId;
            }
        }
        if (game.playoffTierType === 'WINNERS_BRACKET') {
            if (finalPlayoffWeek === null || game.matchupPeriodId > finalPlayoffWeek) {
                finalPlayoffWeek = game.matchupPeriodId;
                champGame = null;
            }
            if (game.matchupPeriodId === finalPlayoffWeek && game.winner && game.winner !== 'UNDECIDED' && game.winner !== 'TIE') {
                champGame = game;
            }
        }
        // The settled figures are read here, not the live ones. This asks whether a matchup has put a score on the board, and the live block exists from the moment a matchup opens, which would count a matchup barely begun as completed.
        if (game.home && (game.home.totalPoints > 0 || game.home.cumulativeScore?.wins > 0 || game.winner !== "UNDECIDED")) {
            if (game.matchupPeriodId > AppState.maxCompletedWeek) AppState.maxCompletedWeek = game.matchupPeriodId;
        }
    });

    AppState.regSeasonWeeks = firstPlayoffWeek !== null
        ? firstPlayoffWeek - 1
        : (data.settings?.scheduleSettings?.matchupPeriodCount || 16);

    // Whether the season has finished. The last completed week cannot say, since mid-season it only names the last finished matchup. A finished season has its latest scoring period past its final one. The matchup counts are the fallback when those fields are missing, though they cannot speak for roto. If neither pair can be read, the season is taken to be still running.
    const latestPeriod = data.status?.latestScoringPeriod;
    const finalPeriod = data.status?.finalScoringPeriod;
    const currentMatchup = data.status?.currentMatchupPeriod;
    const scheduledMatchups = data.settings?.scheduleSettings?.matchupPeriodCount;
    if (Number.isFinite(latestPeriod) && Number.isFinite(finalPeriod)) {
        AppState.isSeasonOver = latestPeriod > finalPeriod;
    } else if (Number.isFinite(currentMatchup) && Number.isFinite(scheduledMatchups)) {
        AppState.isSeasonOver = currentMatchup > scheduledMatchups;
    } else {
        AppState.isSeasonOver = false;
    }

    // The last completed week is the last matchup with a score on the board, which on the first morning of a new matchup is still the one that ended. The matchup being played is kept beside it, and is zero once the season is over.
    AppState.currentMatchup = (!AppState.isSeasonOver && Number.isFinite(currentMatchup)) ? currentMatchup : 0;

    // The league's own scoring format is preferred over inferring one from scores. A points league that has not played would otherwise read as a category league.
    const scoringType = data.settings?.scoringSettings?.scoringType;
    AppState.isPointsLeague = scoringType
        ? scoringType === 'H2H_POINTS'
        : teams.some(t => t.record?.overall?.pointsFor > 0);
    // Season-long roto has no weekly matchups, so the matchup-based views do not apply and it has views of its own, built from ESPN's season standings.
    AppState.isRotoLeague = scoringType === 'ROTO';

    let championTeamId = null;
    if (champGame) {
        const winningSide = champGame.winner === 'HOME' ? champGame.home : champGame.away;
        if (winningSide) championTeamId = winningSide.teamId;
    }
    // Roto has no bracket to win, so its champion is ESPN's own final standing: the one team ranked first.
    if (AppState.isRotoLeague) {
        const rotoChampion = teams.find(t => t.rankCalculatedFinal === 1);
        championTeamId = rotoChampion ? rotoChampion.id : null;
    }
    // Kept in the state so the Rankings charts can mark the champion without deriving it from the schedule again.
    AppState.championTeamId = championTeamId;

    // A leaderboard sort or filter that made sense for the previous league and not this one is dropped. This must run after the league's scoring type is set.
    normalizePlayerViewStateForLeague();

    // Only the stat ids in the league's scoring items are used for scoring. Those are shown by default, and the rest stay behind the advanced-stats toggle.
    const scoringItems = data.settings?.scoringSettings?.scoringItems || [];
    AppState.scoredStatIds = new Set(scoringItems.map(i => i.statId?.toString()).filter(Boolean));

    // The same items carry the points each stat is worth, which is what makes a points league rankable. The overrides per lineup slot are kept too, keyed by slot, since some stats have a base of zero and score only through an override. The base map keeps its shape.
    AppState.scoringWeights = {};
    AppState.scoringSlotWeights = {};
    AppState.secondaryStatIds = new Set();
    scoringItems.forEach(i => {
        const id = i.statId?.toString();
        if (!id) return;
        if (i.points) AppState.scoringWeights[id] = i.points;
        Object.entries(i.pointsOverrides || {}).forEach(([slot, points]) => {
            if (!points) return;
            const table = AppState.scoringSlotWeights[slot] || (AppState.scoringSlotWeights[slot] = {});
            table[id] = points;
        });
    });
    // An id with no base weight that scores only inside a secondary slot belongs to that group, by the league's own scoring.
    const secondarySlots = SECONDARY_LINEUP_SLOTS[AppState.loadedSport] || new Set();
    Object.entries(AppState.scoringSlotWeights).forEach(([slot, table]) => {
        if (!secondarySlots.has(Number(slot))) return;
        Object.keys(table).forEach(id => {
            if (!AppState.scoringWeights[id]) AppState.secondaryStatIds.add(id);
        });
    });

    // Which roster slots this league uses, by a count above zero. A player's eligible positions are filtered to this set, so no position is shown that the league has no slot for.
    const lineupSlotCounts = data.settings?.rosterSettings?.lineupSlotCounts || {};
    AppState.leagueActiveSlots = new Set(
        Object.keys(lineupSlotCounts).filter(slotId => lineupSlotCounts[slotId] > 0)
    );

    const teamDataMap = {};
    AppState.availableStatsSet.clear();

    teams.forEach(t => {
        // Not on a revalidate. This is how a fresh league starts with every team shown, and on a background refresh it would show again a team the reader had hidden.
        if (!revalidate) AppState.visibleTeams.add(t.id);
        teamDataMap[t.id] = {
            id: t.id,
            name: t.name || `${t.location} ${t.nickname}`,
            abbrev: t.abbrev || (t.name || `${t.location} ${t.nickname}`).substring(0, 4).toUpperCase(),
            seasonCats: {},
            weeklyMatchWins: {},
            weeklyMatchResult: {},
            weeklyCatWins: {},
            weeklyCats: {},
            weeklyTier: {},
            // The weeks this team sat out on a playoff bye. A bye is not a game and belongs in no record, though the team's points that week still count.
            weeklyBye: {},
            // Roto standings come straight off the payload and are never recomputed. ESPN owns that arithmetic, its handling of ties included. They are empty for a league that is not roto.
            rotoPoints: statValue(t.points) || 0,
            rotoPointsByStat: unwrapStats(t.pointsByStat || {}),
            rotoRank: t.rankCalculatedFinal ?? null
        };

        let rawStats = t.valuesByStat || t.record?.overall?.stats || {};
        Object.keys(rawStats).forEach(statId => {
            let val = numericStat(rawStats[statId]);
            teamDataMap[t.id].seasonCats[statId] = val || 0;
            AppState.availableStatsSet.add(statId.toString());
        });
    });

    if (championTeamId !== null && teamDataMap[championTeamId]) {
        teamDataMap[championTeamId].name = `${teamDataMap[championTeamId].name} 👑`;
    }

    AppState.teamStats = Object.values(teamDataMap).sort((a, b) => b.id - a.id);
    AppState.teamColorMap = {};
    // Cleared here on every load, so one league's nicknames are never drawn over another's. The loader that fills them back in is called after this function, since importing it here would close an import cycle.
    AppState.nicknames = new Map();
    AppState.teamStats.forEach((t, i) => {
        AppState.teamColorMap[t.id] = TEAM_COLORS[i % TEAM_COLORS.length];
    });

    schedule.forEach(game => {
        const week = game.matchupPeriodId;
        // The matchup being played is read too, not only the completed ones, so the current timeframe has a row to aggregate on the first morning of a matchup.
        if (!readsAsPlayedMatchup(week, AppState.maxCompletedWeek, AppState.currentMatchup)) return;

        ['home', 'away'].forEach(side => {
            if (game[side] && teamDataMap[game[side].teamId]) {
                const tId = game[side].teamId;
                if (!teamDataMap[tId].weeklyCats[week]) teamDataMap[tId].weeklyCats[week] = {};

                // A bracket tier other than the winners' bracket is a consolation ladder. Every played week is tagged with its tier, so charts can be broken down by it.
                let tier = 'reg';
                if (game.playoffTierType && game.playoffTierType !== 'NONE') {
                    tier = (game.playoffTierType === 'WINNERS_BRACKET') ? 'playoff' : 'consolation';
                }
                teamDataMap[tId].weeklyTier[week] = tier;

                // A playoff bye is a schedule entry with one side. ESPN leaves its winner undecided, which is not a win, so no result is recorded for it at all. The points and the category totals still count.
                const isBye = !game.home || !game.away;
                if (isBye) teamDataMap[tId].weeklyBye[week] = true;

                // A result exists only when the winner does. The matchup being played is admitted so the current view can read it, and its winner is undecided. In the result encoding a zero means a loss, so nothing is written until the winner exists. The category tallies and the points still flow.
                const result = matchResultOf(game, side);

                if (AppState.isPointsLeague) {
                    teamDataMap[tId].weeklyMatchWins[week] = matchupPoints(game[side]);
                    // A points league's week still has a winner, the side that scored more. That result is recorded apart from the points total, so the standings can show a record beside the points.
                    if (!isBye && result !== null) {
                        teamDataMap[tId].weeklyMatchResult[week] = result;
                    }
                } else {
                    if (!isBye) {
                        if (result !== null) {
                            teamDataMap[tId].weeklyMatchWins[week] = result;
                        }

                        // Category wins are wins against an opponent, so a bye records none. A matchup in progress does write here, since the running category total is a live figure and not a record.
                        const tally = matchupTally(game[side]);
                        const cWins = tally?.wins || 0;
                        const cTies = tally?.ties || 0;
                        teamDataMap[tId].weeklyCatWins[week] = cWins + (cTies * 0.5);
                    }
                }

                // The weekly totals per category feed the heatmap and Category Rankings for every league, points leagues included, since a points league accumulates the same stat lines.
                let boxStats = {};
                if (game.boxscore && game.boxscore[side] && game.boxscore[side].statistics) {
                    game.boxscore[side].statistics.forEach(s => {
                        boxStats[s.statId.toString()] = numericStat(firstDefined(s.appliedTotal, s.value));
                    });
                } else {
                    // Read off the same block the tally came from, through the same helper the header uses, so the category rows and the record over them describe the same moment.
                    Object.assign(boxStats, matchupCatsForSide(game[side]));
                }

                for (let sId in boxStats) {
                    teamDataMap[tId].weeklyCats[week][sId] = boxStats[sId] || 0;
                    AppState.availableStatsSet.add(sId);
                }
            }
        });
    });

    const currentWeek = data.status?.currentMatchupPeriod || 1;
    let activeMatchups = 0;
    let scoreboardHtml = `<div style="display:flex; flex-direction:column; gap:6px;">`;

    schedule.forEach(g => {
        if (g.matchupPeriodId === currentWeek && g.home && g.away) {
            activeMatchups++;

            const hId = g.home.teamId;
            const aId = g.away.teamId;
            // Escaped at the source. Team names are set by league members and go into markup below, so markup in a name must render as text.
            const homeName = escapeHtml(teamDataMap[hId]?.name || `Team ${hId}`);
            const awayName = escapeHtml(teamDataMap[aId]?.name || `Team ${aId}`);

            const hTeamColor = AppState.teamColorMap[hId] || '#888';
            const aTeamColor = AppState.teamColorMap[aId] || '#888';

            let hValue = 0, aValue = 0, homeScoreStr = '', awayScoreStr = '';

            if (AppState.isPointsLeague) {
                hValue = matchupPoints(g.home);
                aValue = matchupPoints(g.away);
                homeScoreStr = hValue.toFixed(1);
                awayScoreStr = aValue.toFixed(1);
            } else {
                const hTally = matchupTally(g.home);
                const aTally = matchupTally(g.away);
                hValue = hTally?.wins || 0;
                aValue = aTally?.wins || 0;
                const hTies = hTally?.ties || 0;
                const hLosses = hTally?.losses || 0;
                const aTies = aTally?.ties || 0;
                const aLosses = aTally?.losses || 0;
                homeScoreStr = `${hValue}-${hLosses}-${hTies}`;
                awayScoreStr = `${aValue}-${aLosses}-${aTies}`;
            }

            const hColor = hValue > aValue ? '#fff' : (hValue < aValue ? '#888' : '#bbb');
            const aColor = aValue > hValue ? '#fff' : (aValue < hValue ? '#888' : '#bbb');
            const hScoreColor = hValue > aValue ? '#4db8ff' : (hValue < aValue ? '#666' : '#888');
            const aScoreColor = aValue > hValue ? '#4db8ff' : (aValue < hValue ? '#666' : '#888');

            scoreboardHtml += `
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; background:rgba(255,255,255,0.05); padding:8px; border-radius:4px;">
                    <div style="flex:1; text-align:right; overflow:hidden;">
                        <div style="white-space:nowrap; text-overflow:ellipsis; overflow:hidden; font-weight:bold; color:${aColor};">
                            <span style="display:inline-block; width:8px; height:8px; background:${aTeamColor}; border-radius:50%; margin-right:5px;"></span>${awayName}
                        </div>
                        <div style="color:${aScoreColor}; font-weight:bold; margin-top:2px;">${awayScoreStr}</div>
                    </div>
                    <div style="padding:0 12px; color:#555; font-size:10px; font-weight:bold;">@</div>
                    <div style="flex:1; text-align:left; overflow:hidden;">
                        <div style="white-space:nowrap; text-overflow:ellipsis; overflow:hidden; font-weight:bold; color:${hColor};">
                            ${homeName}<span style="display:inline-block; width:8px; height:8px; background:${hTeamColor}; border-radius:50%; margin-left:5px;"></span>
                        </div>
                        <div style="color:${hScoreColor}; font-weight:bold; margin-top:2px;">${homeScoreStr}</div>
                    </div>
                </div>
            `;
        }
    });
    scoreboardHtml += `</div>`;

    const weekIndicator = document.getElementById('week-indicator');
    const scoreboardDropdown = document.getElementById('scoreboard-dropdown');

    if (weekIndicator && scoreboardDropdown) {
        // Roto has no matchup periods, so this whole control is hidden.
        weekIndicator.style.display = AppState.isRotoLeague ? 'none' : '';
        // Before the season the label is kept and greyed, with the reason on hover. A league in its preseason has matchup periods and has not played them, which is not the same as roto having none.
        const preseason = isPreseason(seasonState(data));
        weekIndicator.classList.toggle('week-indicator-quiet', preseason);
        weekIndicator.title = preseason ? 'No games yet. Every figure on this page is a projection.' : '';
        // The unit is the matchup, not the week. This indicator is drawn only for leagues that play matchups.
        weekIndicator.innerHTML = `${axisUnit().long} ${currentWeek}<span class="wk-count"> <span style="color:#ccc; margin: 0 4px;">|</span> ${activeMatchups} Matchups</span> ▾`;
        const formatBadge = leagueTypeBadge(scoringType);
        const metaHtml = `<div class="sb-meta"><div class="sb-format">${formatBadge ? formatBadge.label : ''}</div><div class="sb-count">${activeMatchups} Matchups</div></div>`;
        // A recap is one matchup's story, which roto has no equivalent of, so the button is disabled and says why.
        const recapBtn = document.getElementById('recap-btn');
        if (recapBtn) {
            recapBtn.disabled = AppState.isRotoLeague;
            recapBtn.title = AppState.isRotoLeague
                ? 'Recaps cover a single matchup, and roto leagues play the whole season at once.'
                : 'Build a shareable image + text recap of a matchup week';
        }
        if (preseason) {
            scoreboardDropdown.innerHTML = `<div style="font-size:12px; color:#aaa; text-align:center;">No games yet.</div>`;
        } else if (activeMatchups > 0) {
            scoreboardDropdown.innerHTML = `${metaHtml}<div style="font-size:12px; font-weight:bold; margin-bottom:12px; color:#fff; border-bottom:1px solid #444; padding-bottom:6px; text-align:center;">${axisUnit().long} ${currentWeek} Live Scoreboard</div>` + scoreboardHtml;
        } else {
            scoreboardDropdown.innerHTML = `<div style="font-size:12px; color:#aaa; text-align:center;">No active matchups available.</div>`;
        }
    }

    // The league-type badge, shown on every panel. The mapping lives in utils.js and is only attached here.
    const badgeEl = document.getElementById('league-type-badge');
    if (badgeEl) {
        const badge = leagueTypeBadge(scoringType);
        if (badge) {
            badgeEl.textContent = badge.label;
            badgeEl.style.display = '';
        } else {
            badgeEl.style.display = 'none';
        }
    }

    // The year list is built from the seasons this league existed for. The league's history covers past seasons only, so the current year is always added. Next year is not, since ESPN answers 404 for a season that does not exist yet.
    const yearSelect = document.getElementById('year');
    // Built through the shared rule, so this list and the History tab's cannot disagree, and with the seasons this session has already loaded for the league.
    noteSeasonSeen(AppState.loadedSport, data.id, data.seasonId);
    const { years: sortedYears, selected: currentYearVal } = yearDropdownFor(
        yearSelect.value, data.seasonId,
        [...(AppState.leagueHistoryYears || []), ...seasonsSeenFor(AppState.loadedSport, data.id)],
        new Date().getFullYear());
    yearSelect.innerHTML = '';
    sortedYears.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (y === currentYearVal) opt.selected = true;
        yearSelect.appendChild(opt);
    });

    // The default is forced only on a fetch. A revalidate is the same season, so the reader's own selection is still valid.
    rebuildTimeframeOptions(!revalidate);
    buildTeamFilterChips();
    buildNicknamesSheet();
    refreshMyTeamTabAvailability();
    refreshDraftTabAvailability();

    // The whole tab, whichever face it wears.
    renderTeamMetricsTab();
    // And whichever tab is on screen. A fetch finished while another tab is showing would otherwise leave the previous league there. The registry answers for every tab at once.
    renderActiveLeagueView();

    // An open drill-down or comparison is not redrawn by the registry, so a revalidate asks it to redraw itself. The league's bounds are what a revalidate moves, and the chart's axis is built from them.
    if (revalidate) {
        if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        // On a revalidate the player pool is flagged stale and not fetched again at once. The first view that shows pool figures consumes the flag, and a view already on screen consumes it immediately. The weekly history, the roster snapshots and the transaction log are not harvested again here.
        AppState.playerPoolStale = true;
        const visible = (id) => {
            const el = document.getElementById(id);
            return el && el.style.display !== 'none';
        };
        const poolOnScreen = visible('view-player') || visible('view-myteam')
            || (visible('view-team') && AppState.isRotoLeague);
        if (poolOnScreen) revalidateStalePoolIfDue();
        revalidateLeagueViews();
        return;
    }

    // The player pool is large, so its fetch starts in the background now and the Player Metrics tab opens quickly later.
    prefetchPlayerData();
}
