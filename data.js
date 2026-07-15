import { AppState, TEAM_COLORS } from './state.js';
import { rebuildTimeframeOptions, buildCheckboxes, buildLegend, collapseSettingsBar } from './controls.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { resetLeaderboardWeeklyFetchState, prefetchPlayerData } from './players.js';
import { statValue, firstDefined } from './utils.js';

// Every real caller is a genuine new league/year/sport fetch (api.js). There's no lighter "re-render without resetting" call anywhere in the project, so this always resets.
export function processCoreData() {
    if (!AppState.apiData) return;
    document.getElementById('results').style.display = 'flex';
    // Data's in. Tuck the one-time setup fields away behind the gear button.
    collapseSettingsBar();

    // A fresh league/year/sport fetch invalidates any previously loaded player pool. It'll be lazily re-fetched next time the Player Metrics tab is opened.
    AppState.playerData = [];
    AppState.playerDataLoaded = false;
    AppState.playerWeeklyCache = {};
    AppState.selectedPlayerId = null;
    // A failed bulk weekly-stats fetch (see ensureLeaderboardWeeklyDataLoaded in players.js) from a previous league/season shouldn't permanently block this new one from trying.
    resetLeaderboardWeeklyFetchState();
    // A stale AppState.timeframe selection from a previous season (e.g, "reg", forced by a playoff-less season) would otherwise silently carry over and hide postseason data on this fetch. Handled by rebuildTimeframeOptions(true) below, which forces the correct default once this season's own hasPlayoffs is known.
    const pieSelector = document.getElementById('pie-selector');
    if (pieSelector) pieSelector.value = 'rankings';

    const data = AppState.apiData;
    const teams = data.teams || [];
    const schedule = data.schedule || [];

    // Determine the regular season boundary, the playoff champion, and the last completed week together in a single schedule scan (each is a running min/max/candidate computation with no dependency on the others), rather than three separate full scans.
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
        if (game.home && (game.home.totalPoints > 0 || game.home.cumulativeScore?.wins > 0 || game.winner !== "UNDECIDED")) {
            if (game.matchupPeriodId > AppState.maxCompletedWeek) AppState.maxCompletedWeek = game.matchupPeriodId;
        }
    });

    AppState.regSeasonWeeks = firstPlayoffWeek !== null
        ? firstPlayoffWeek - 1
        : (data.settings?.scheduleSettings?.matchupPeriodCount || 16);

    let championTeamId = null;
    if (champGame) {
        const winningSide = champGame.winner === 'HOME' ? champGame.home : champGame.away;
        if (winningSide) championTeamId = winningSide.teamId;
    }
    // Exposed on AppState (not just the "👑" name suffix below) so the Rankings bar charts can mark the champion directly, without re-deriving it from the schedule a second time.
    AppState.championTeamId = championTeamId;
    // Prefer the league's actual scoring format over guessing from scores: a points league with no games played yet (all pointsFor === 0) would otherwise be misread as a category league.
    const scoringType = data.settings?.scoringSettings?.scoringType;
    AppState.isPointsLeague = scoringType
        ? scoringType === 'H2H_POINTS'
        : teams.some(t => t.record?.overall?.pointsFor > 0);

    // Only the stat ids listed in scoringItems are actually used for standings/scoring in this league. Everything else in ESPN_STAT_MAPS is just data ESPN happens to track.
    const scoringItems = data.settings?.scoringSettings?.scoringItems || [];
    AppState.scoredStatIds = new Set(scoringItems.map(i => i.statId?.toString()).filter(Boolean));

    // Which roster slots this league actually uses (nonzero count). e.g. a league might only roster a generic OF slot with no separate LF/CF/RF, or vice versa.
    const lineupSlotCounts = data.settings?.rosterSettings?.lineupSlotCounts || {};
    AppState.leagueActiveSlots = new Set(
        Object.keys(lineupSlotCounts).filter(slotId => lineupSlotCounts[slotId] > 0)
    );

    const teamDataMap = {};
    AppState.availableStatsSet.clear();

    teams.forEach(t => {
        AppState.visibleTeams.add(t.id);
        teamDataMap[t.id] = {
            id: t.id,
            name: t.name || `${t.location} ${t.nickname}`,
            abbrev: t.abbrev || (t.name || `${t.location} ${t.nickname}`).substring(0, 4).toUpperCase(),
            seasonCats: {},
            weeklyMatchWins: {},
            weeklyCatWins: {},
            weeklyCats: {},
            weeklyTier: {}
        };

        let rawStats = t.valuesByStat || t.record?.overall?.stats || {};
        Object.keys(rawStats).forEach(statId => {
            let val = statValue(rawStats[statId]);
            teamDataMap[t.id].seasonCats[statId] = val || 0;
            AppState.availableStatsSet.add(statId.toString());
        });
    });

    if (championTeamId !== null && teamDataMap[championTeamId]) {
        teamDataMap[championTeamId].name = `${teamDataMap[championTeamId].name} 👑`;
    }

    AppState.teamStats = Object.values(teamDataMap).sort((a, b) => b.id - a.id);
    AppState.teamColorMap = {};
    AppState.teamStats.forEach((t, i) => {
        AppState.teamColorMap[t.id] = TEAM_COLORS[i % TEAM_COLORS.length];
    });

    schedule.forEach(game => {
        const week = game.matchupPeriodId;
        if (week > AppState.maxCompletedWeek) return;

        ['home', 'away'].forEach(side => {
            if (game[side] && teamDataMap[game[side].teamId]) {
                const tId = game[side].teamId;
                if (!teamDataMap[tId].weeklyCats[week]) teamDataMap[tId].weeklyCats[week] = {};

                // Any bracket tier other than the winners bracket is a consolation ladder. Those teams are no longer playing for the actual championship.
                let tier = 'reg';
                if (game.playoffTierType && game.playoffTierType !== 'NONE') {
                    tier = (game.playoffTierType === 'WINNERS_BRACKET') ? 'playoff' : 'consolation';
                }
                teamDataMap[tId].weeklyTier[week] = tier;

                if (AppState.isPointsLeague) {
                    teamDataMap[tId].weeklyMatchWins[week] = game[side].totalPoints || 0;
                } else {
                    let mWin = (game.winner === side.toUpperCase()) ? 1 : 0;
                    if (game.winner === "TIE") mWin = 0.5;
                    teamDataMap[tId].weeklyMatchWins[week] = mWin;

                    const cWins = game[side].cumulativeScore?.wins || 0;
                    const cTies = game[side].cumulativeScore?.ties || 0;
                    teamDataMap[tId].weeklyCatWins[week] = cWins + (cTies * 0.5);

                    let boxStats = {};
                    if (game.boxscore && game.boxscore[side] && game.boxscore[side].statistics) {
                        game.boxscore[side].statistics.forEach(s => {
                            boxStats[s.statId.toString()] = firstDefined(s.appliedTotal, s.value);
                        });
                    } else {
                        const statsObj = game[side].cumulativeScore?.scoreByStat || game[side].cumulativeScore?.statBySlot || {};
                        for (let key in statsObj) {
                            const statData = statsObj[key];
                            const sId = statData.statId !== undefined ? statData.statId.toString() : key;
                            boxStats[sId] = firstDefined(statData.score, statData.value);
                        }
                    }

                    for (let sId in boxStats) {
                        teamDataMap[tId].weeklyCats[week][sId] = boxStats[sId] || 0;
                        AppState.availableStatsSet.add(sId);
                    }
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
            const homeName = teamDataMap[hId]?.name || `Team ${hId}`;
            const awayName = teamDataMap[aId]?.name || `Team ${aId}`;

            const hTeamColor = AppState.teamColorMap[hId] || '#888';
            const aTeamColor = AppState.teamColorMap[aId] || '#888';

            let hValue = 0, aValue = 0, homeScoreStr = '', awayScoreStr = '';

            if (AppState.isPointsLeague) {
                hValue = g.home.totalPoints || 0;
                aValue = g.away.totalPoints || 0;
                homeScoreStr = hValue.toFixed(1);
                awayScoreStr = aValue.toFixed(1);
            } else {
                hValue = g.home.cumulativeScore?.wins || 0;
                aValue = g.away.cumulativeScore?.wins || 0;
                const hTies = g.home.cumulativeScore?.ties || 0;
                const hLosses = g.home.cumulativeScore?.losses || 0;
                const aTies = g.away.cumulativeScore?.ties || 0;
                const aLosses = g.away.cumulativeScore?.losses || 0;
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
        weekIndicator.innerHTML = `Week ${currentWeek} <span style="color:#ccc; margin: 0 4px;">|</span> ${activeMatchups} Matchups ▾`;
        if (activeMatchups > 0) {
            scoreboardDropdown.innerHTML = `<div style="font-size:12px; font-weight:bold; margin-bottom:12px; color:#fff; border-bottom:1px solid #444; padding-bottom:6px; text-align:center;">Week ${currentWeek} Live Scoreboard</div>` + scoreboardHtml;
        } else {
            scoreboardDropdown.innerHTML = `<div style="font-size:12px; color:#aaa; text-align:center;">No active matchups available.</div>`;
        }
    }

    // Populate the year dropdown from the seasons this specific league (this sport + league ID) actually existed for. See fetchLeagueHistorySeasons in api.js. leagueHistory only covers completed past seasons, not the current/in-progress one, so also guarantee this real-world year is always selectable. Otherwise a league whose current season hasn't been "historicized" yet loses its own active year entirely.
    const yearSelect = document.getElementById('year');
    const currentYearVal = parseInt(yearSelect.value);
    const apiSeasonId = data.seasonId || currentYearVal;
    const thisRealYear = new Date().getFullYear();

    let availableYears = new Set([currentYearVal, apiSeasonId, thisRealYear, ...AppState.leagueHistoryYears]);

    const sortedYears = Array.from(availableYears).sort((a, b) => b - a);
    yearSelect.innerHTML = '';
    sortedYears.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (y === currentYearVal) opt.selected = true;
        yearSelect.appendChild(opt);
    });

    rebuildTimeframeOptions(true);
    buildCheckboxes();
    buildLegend();

    renderLeftColumn();
    renderRightColumn();
    renderHeatmapBand();

    // Start pulling the (big, ~5s) Player Metrics pool in the background right away, so the tab opens near-instantly when it's eventually clicked. See prefetchPlayerData.
    prefetchPlayerData();
}