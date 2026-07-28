import { AppState, TEAM_COLORS } from './state.js';
import { rebuildTimeframeOptions, renderCategoryAdvancedToggle, buildLegend, collapseSettingsBar } from './controls.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand, resetRankingsViewState } from './graphs.js';
import { resetLeaderboardWeeklyFetchState, normalizePlayerViewStateForLeague, prefetchPlayerData } from './players.js';
import { statValue, unwrapStats, firstDefined, escapeHtml, axisUnit, numericStat } from './utils.js';
import { resetMyTeamView, renderMyTeamTab } from './myteam.js';

// ESPN's own game ids, the authoritative statement of what sport a payload is. Only the two this app supports are mapped, and anything else falls back to the form.
const GAME_ID_SPORTS = { 2: 'flb', 4: 'fhl' };

// Every caller is a genuine new league, year or sport fetch, so this always resets.
export function processCoreData() {
    if (!AppState.apiData) return;
    document.getElementById('results').style.display = 'flex';
    // Data's in - tuck the one-time setup fields away behind the gear button.
    collapseSettingsBar();

    // First, because everything below it describes the league now loading and must read its sport from here rather than from the form. gameId is the payload's own answer, so a restored session and a fresh fetch agree.
    AppState.loadedSport = GAME_ID_SPORTS[AppState.apiData.gameId]
        || document.getElementById('sport').value
        || 'flb';

    // A fresh fetch invalidates the loaded player pool, which is re-fetched lazily when the Player Metrics tab opens.
    AppState.playerData = [];
    AppState.playerDataLoaded = false;
    // A previous league's pool failure says nothing about this one, and the user may have logged in since.
    AppState.playerDataError = null;
    AppState.playerWeeklyCache = {};
    AppState.selectedPlayerId = null;
    // A failed bulk weekly-stats fetch from a previous season must not permanently block this one from trying.
    resetLeaderboardWeeklyFetchState();
    // The viewed category and any sections flipped to a pie belong to the league that was on screen, so a new league starts from its own first category with every section back on bars.
    resetRankingsViewState();
    // The scouted team belongs to the league that was on screen, so a new league starts on its own owner's team again.
    resetMyTeamView();
    // A stale timeframe from a playoff-less season would hide postseason data here, so rebuildTimeframeOptions forces the right default once this season's own hasPlayoffs is known.

    const data = AppState.apiData;
    const teams = data.teams || [];
    const schedule = data.schedule || [];

    // One schedule scan finds all three: the regular season boundary (earliest playoff matchupPeriodId minus one), the champion (winner of the WINNERS_BRACKET game at the latest playoff week), and the last completed week.
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

    // A finished season has status.latestScoringPeriod past status.finalScoringPeriod, verified against real captures. currentMatchupPeriod vs matchupPeriodCount is the fallback, and cannot speak for roto, so if neither pair is readable assume the season is still running.
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

    // maxCompletedWeek is the last matchup with a score on the board, which on the first morning of a new matchup is still the one that just ended, so the timeframe pills need the live one too. Zero once the season is over, since then there is no matchup being played.
    AppState.currentMatchup = (!AppState.isSeasonOver && Number.isFinite(currentMatchup)) ? currentMatchup : 0;

    // Prefer the league's own scoring format over guessing from scores, or a points league with no games played yet reads as a category league.
    const scoringType = data.settings?.scoringSettings?.scoringType;
    AppState.isPointsLeague = scoringType
        ? scoringType === 'H2H_POINTS'
        : teams.some(t => t.record?.overall?.pointsFor > 0);
    // Season-long roto accumulates with no weekly matchups, so Team Metrics is built from ESPN's season standings instead.
    AppState.isRotoLeague = scoringType === 'ROTO';

    let championTeamId = null;
    if (champGame) {
        const winningSide = champGame.winner === 'HOME' ? champGame.home : champGame.away;
        if (winningSide) championTeamId = winningSide.teamId;
    }
    // Roto has no bracket to win, so the champion is ESPN's own rankCalculatedFinal of 1 rather than a WINNERS_BRACKET game.
    if (AppState.isRotoLeague) {
        const rotoChampion = teams.find(t => t.rankCalculatedFinal === 1);
        championTeamId = rotoChampion ? rotoChampion.id : null;
    }
    // Exposed on AppState so the Rankings bars can mark the champion without re-deriving it from the schedule.
    AppState.championTeamId = championTeamId;

    // Drop a leaderboard sort that made sense for the previous league, above all a roto sort surviving into a points league that has no roto ranks. Must run after isPointsLeague is set.
    normalizePlayerViewStateForLeague();

    // Only the ids in scoringItems count for this league's standings. Everything else in ESPN_STAT_MAPS is data ESPN happens to track, kept behind Advanced Stats.
    const scoringItems = data.settings?.scoringSettings?.scoringItems || [];
    AppState.scoredStatIds = new Set(scoringItems.map(i => i.statId?.toString()).filter(Boolean));

    // The same items carry the points each stat is worth, which is what makes a points league rankable. pointsOverrides holds per-position weights when a league uses them, and a league that does keeps its base weight here, so its rank is coarse for those positions rather than wrong for everyone.
    AppState.scoringWeights = {};
    scoringItems.forEach(i => {
        const id = i.statId?.toString();
        if (id && i.points) AppState.scoringWeights[id] = i.points;
    });

    // Only the roster slots this league actually uses, so a player is never split into positions the league has no spots for.
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
            weeklyMatchResult: {},
            weeklyCatWins: {},
            weeklyCats: {},
            weeklyTier: {},
            // Weeks this team sat out, meaning a playoff bye. Not a game, so it belongs in no record, but the team still played real games that week and its points still count.
            weeklyBye: {},
            // Roto standings come straight off the payload and are never recomputed. ESPN owns that math including its tie handling, which is why per-category points can arrive as halves.
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

                // Any bracket tier other than the winners bracket is a consolation ladder. Every played week carries its tier so the charts can break down by it.
                let tier = 'reg';
                if (game.playoffTierType && game.playoffTierType !== 'NONE') {
                    tier = (game.playoffTierType === 'WINNERS_BRACKET') ? 'playoff' : 'consolation';
                }
                teamDataMap[tId].weeklyTier[week] = tier;

                // A playoff bye is a schedule entry with only one side: ESPN gives the resting team a game with no opponent and leaves winner UNDECIDED. Every result line below reads whether this side won, and UNDECIDED is not a win, so a bye was booking a loss against a team that never played. Record no result at all, since the tallies already skip a week with none, while the points and per-category totals still land because those games were played.
                const isBye = !game.home || !game.away;
                if (isBye) teamDataMap[tId].weeklyBye[week] = true;

                if (AppState.isPointsLeague) {
                    teamDataMap[tId].weeklyMatchWins[week] = game[side].totalPoints || 0;
                    // A points-league week still has a real winner. That 1/0.5/0 result is recorded separately from the points total, so the standings can show a genuine record alongside points for.
                    if (!isBye) {
                        let pWin = (game.winner === side.toUpperCase()) ? 1 : 0;
                        if (game.winner === "TIE") pWin = 0.5;
                        teamDataMap[tId].weeklyMatchResult[week] = pWin;
                    }
                } else {
                    if (!isBye) {
                        let mWin = (game.winner === side.toUpperCase()) ? 1 : 0;
                        if (game.winner === "TIE") mWin = 0.5;
                        teamDataMap[tId].weeklyMatchWins[week] = mWin;

                        // Category wins are wins against an opponent, so a bye has none to record, and writing a zero would read as losing every category that week.
                        const cWins = game[side].cumulativeScore?.wins || 0;
                        const cTies = game[side].cumulativeScore?.ties || 0;
                        teamDataMap[tId].weeklyCatWins[week] = cWins + (cTies * 0.5);
                    }
                }

                // Per-category weekly totals feed the heatmap and Category Rankings for every league, points included, so this capture stays outside the category-only branch above.
                let boxStats = {};
                if (game.boxscore && game.boxscore[side] && game.boxscore[side].statistics) {
                    game.boxscore[side].statistics.forEach(s => {
                        boxStats[s.statId.toString()] = numericStat(firstDefined(s.appliedTotal, s.value));
                    });
                } else {
                    const statsObj = game[side].cumulativeScore?.scoreByStat || game[side].cumulativeScore?.statBySlot || {};
                    for (let key in statsObj) {
                        const statData = statsObj[key];
                        const sId = statData.statId !== undefined ? statData.statId.toString() : key;
                        boxStats[sId] = numericStat(firstDefined(statData.score, statData.value));
                    }
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
            // Escaped at the source: team names are set by league members and land in innerHTML below.
            const homeName = escapeHtml(teamDataMap[hId]?.name || `Team ${hId}`);
            const awayName = escapeHtml(teamDataMap[aId]?.name || `Team ${aId}`);

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
        // Roto has no matchup periods and no scoreboard behind them, so this control stands down rather than reading Week 1 forever.
        weekIndicator.style.display = AppState.isRotoLeague ? 'none' : '';
        // Matchup, not Week: currentWeek is status.currentMatchupPeriod, and this only ever renders for matchup leagues.
        weekIndicator.innerHTML = `${axisUnit().long} ${currentWeek} <span style="color:#ccc; margin: 0 4px;">|</span> ${activeMatchups} Matchups ▾`;
        // A recap is a single matchup's story, which roto has no equivalent of.
        const recapBtn = document.getElementById('recap-btn');
        if (recapBtn) {
            recapBtn.disabled = AppState.isRotoLeague;
            recapBtn.title = AppState.isRotoLeague
                ? 'Recaps cover a single matchup, and roto leagues play the whole season at once.'
                : 'Build a shareable image + text recap of a matchup week';
        }
        if (activeMatchups > 0) {
            scoreboardDropdown.innerHTML = `<div style="font-size:12px; font-weight:bold; margin-bottom:12px; color:#fff; border-bottom:1px solid #444; padding-bottom:6px; text-align:center;">${axisUnit().long} ${currentWeek} Live Scoreboard</div>` + scoreboardHtml;
        } else {
            scoreboardDropdown.innerHTML = `<div style="font-size:12px; color:#aaa; text-align:center;">No active matchups available.</div>`;
        }
    }

    // leagueHistory only covers completed seasons, so the current real-world year is always selectable. Next year is deliberately left out, since ESPN 404s on a season that does not exist yet.
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
    renderCategoryAdvancedToggle();
    buildLegend();

    renderLeftColumn();
    renderRightColumn();
    renderHeatmapBand();
    // My Team too, for the same reason the Team Metrics boxes re-render here: a fetch committed while that tab is the one on screen would otherwise leave the previous league's roster sitting there.
    renderMyTeamTab();

    // Start the large player pool fetch in the background so the Player Metrics tab opens fast when it is clicked.
    prefetchPlayerData();
}