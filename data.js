import { AppState, TEAM_COLORS } from './state.js';
import { rebuildTimeframeOptions, renderCategoryAdvancedToggle, buildLegend, collapseSettingsBar } from './controls.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand, resetRankingsViewState } from './graphs.js';
import { resetLeaderboardWeeklyFetchState, normalizePlayerViewStateForLeague, prefetchPlayerData } from './players.js';
import { statValue, unwrapStats, firstDefined, escapeHtml, axisUnit, numericStat } from './utils.js';
import { resetMyTeamView, renderMyTeamTab } from './myteam.js';

// ESPN's own game ids, the authoritative statement of what sport a payload IS. Only the two this app supports are mapped; anything else falls back to the form (see AppState.loadedSport).
const GAME_ID_SPORTS = { 2: 'flb', 4: 'fhl' };

// Every real caller is a genuine new league/year/sport fetch (api.js) - there's no lighter "re-render without resetting" call anywhere in the project, so this always resets.
export function processCoreData() {
    if (!AppState.apiData) return;
    document.getElementById('results').style.display = 'flex';
    // Data's in - tuck the one-time setup fields away behind the gear button.
    collapseSettingsBar();

    // FIRST, because everything below it (normalizePlayerViewStateForLeague especially) describes the league now loading and must read its sport from here rather than from the form. gameId is the payload's own answer, so a restored session and a fresh fetch agree, and the dropdown is only the fallback for a payload that somehow carries no gameId.
    AppState.loadedSport = GAME_ID_SPORTS[AppState.apiData.gameId]
        || document.getElementById('sport').value
        || 'flb';

    // A fresh league/year/sport fetch invalidates any previously loaded player pool - it'll be lazily re-fetched next time the Player Metrics tab is opened.
    AppState.playerData = [];
    AppState.playerDataLoaded = false;
    // A previous league's pool failure says nothing about this one, and the user may have logged in since.
    AppState.playerDataError = null;
    AppState.playerWeeklyCache = {};
    AppState.selectedPlayerId = null;
    // A failed bulk weekly-stats fetch (see ensureLeaderboardWeeklyDataLoaded in players.js) from a previous league/season shouldn't permanently block this new one from trying.
    resetLeaderboardWeeklyFetchState();
    // Rankings box view position is not data. The viewed category and any sections flipped to a pie both belong to the league that was on screen, so a new league starts from its own first category with every section back on bars (B79/).
    resetRankingsViewState();
    // The scouted team belongs to the league that was on screen, so a new league starts on its own owner's team again.
    resetMyTeamView();
    // A stale AppState.timeframe selection from a previous season (e.g. "reg", forced by a playoff-less season) would otherwise silently carry over and hide postseason data on this fetch - handled by rebuildTimeframeOptions(true) below, which forces the correct default once this season's own hasPlayoffs is known. (The Bar/Pie dropdown that used to be reset alongside it is gone - pies live behind each section's own arrow now, and resetRankingsViewState above clears those.)

    const data = AppState.apiData;
    const teams = data.teams || [];
    const schedule = data.schedule || [];

    // Determine the regular season boundary, the playoff champion, and the last completed week together in a single schedule scan (each is a running min/max/candidate computation with no dependency on the others), rather than three separate full scans. Regular season boundary. Each schedule game carries playoffTierType, which is "NONE" for regular season games and something else (WINNERS_BRACKET, LOSERS_CONSOLATION_LADDER, etc.) once a league enters its playoff bracket. The earliest playoff matchupPeriodId minus one is the true end of the regular season. Champion: whoever wins the WINNERS_BRACKET game at the LATEST playoff week seen - once a team loses in the winners bracket they get shunted to a consolation tier for the rest of the playoffs, so by the final round only the two finalists are still tagged WINNERS_BRACKET that week. champGame is reset whenever a later week's WINNERS_BRACKET game is found, so an in-progress final round (no decided winner yet) correctly leaves championTeamId null instead of crowning whoever won an earlier round.
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

    // Has this league's season actually FINISHED? maxCompletedWeek can't answer that - mid-season it just means "last completed matchup", so an end-of-season marker keyed off it drew before the in-progress matchup and claimed the season was over while it was still running. Field names verified against real captures in JSON_debug, not guessed. A finished season has status.latestScoringPeriod PAST status.finalScoringPeriod (completed 2026 hockey 193 > 192, completed 2025 MLB 196 > 195, roto 193 > 192), while a live one sits well short of it (in-progress 2026 MLB at 104-112 of 187). status.currentMatchupPeriod vs scheduleSettings.matchupPeriodCount agrees on every H2H capture (24-25 played of 21 scheduled when done, 15 of 21 while live) but can't speak for roto, whose matchupPeriodCount is 1 and would read as "not over" forever - so it's only the fallback when the scoring-period fields are missing. If neither pair is readable, assume the season is still running. A missing divider is a far smaller error than falsely announcing the season ended.
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

    // maxCompletedWeek is the last matchup with a SCORE on the board, which on the first morning of a new matchup is still the one that just ended. The timeframe pills need the live one too, or "This Matchup" quietly shows last week. Zero once the season is over, since then there is no matchup being played and the last completed one is the right anchor for every window.
    AppState.currentMatchup = (!AppState.isSeasonOver && Number.isFinite(currentMatchup)) ? currentMatchup : 0;

    // Prefer the league's actual scoring format over guessing from scores. A points league with no games played yet (all pointsFor === 0) would otherwise be misread as a category league.
    const scoringType = data.settings?.scoringSettings?.scoringType;
    AppState.isPointsLeague = scoringType
        ? scoringType === 'H2H_POINTS'
        : teams.some(t => t.record?.overall?.pointsFor > 0);
    // Season-long roto accumulates over the whole season with no weekly matchups, so the matchup-based half of Team Metrics has nothing to stand on - it gets its own views built from ESPN's own season standings numbers instead (B31-FULL).
    AppState.isRotoLeague = scoringType === 'ROTO';

    let championTeamId = null;
    if (champGame) {
        const winningSide = champGame.winner === 'HOME' ? champGame.home : champGame.away;
        if (winningSide) championTeamId = winningSide.teamId;
    }
    // Roto has no bracket to win, so the championship signal is ESPN's own final standing rather than a WINNERS_BRACKET game. Verified present on both FGB captures (2025 and 2024), where exactly one team carries rankCalculatedFinal 1 even though 2024 has a genuine tie further down the table.
    if (AppState.isRotoLeague) {
        const rotoChampion = teams.find(t => t.rankCalculatedFinal === 1);
        championTeamId = rotoChampion ? rotoChampion.id : null;
    }
    // Exposed on AppState (not just the "👑" name suffix below) so the Rankings bar charts can mark the champion directly, without re-deriving it from the schedule a second time.
    AppState.championTeamId = championTeamId;

    // Drop any leaderboard sort/filter that made sense for the previous league but not this one - above all a 'rotoScore' sort surviving into a points league, which has no rotoRanks and crashed the player tab. Must run after isPointsLeague is set above.
    normalizePlayerViewStateForLeague();

    // Only the stat ids listed in scoringItems are actually used for standings/scoring in this league - everything else in ESPN_STAT_MAPS is just data ESPN happens to track. Surface the scored ones by default and keep the rest tucked behind "Advanced Stats" in the Player Metrics tab rather than dumping every tracked stat on the leaderboard.
    const scoringItems = data.settings?.scoringSettings?.scoringItems || [];
    AppState.scoredStatIds = new Set(scoringItems.map(i => i.statId?.toString()).filter(Boolean));

    // The same items carry the POINTS each stat is worth, which is what makes a points league rankable. pointsOverrides holds per-position weights when a league uses them; none of the captures do, so a league that does keeps its base weight here and its rank is honest but slightly coarse for the overridden positions rather than wrong for everyone.
    AppState.scoringWeights = {};
    scoringItems.forEach(i => {
        const id = i.statId?.toString();
        if (id && i.points) AppState.scoringWeights[id] = i.points;
    });

    // Which roster slots this league actually uses (nonzero count) - e.g. a league might only roster a generic OF slot with no separate LF/CF/RF, or vice versa. Player eligible positions get filtered down to this set so a player isn't shown split into positions this league doesn't even have roster spots for (see SLOT_POSITION_MAPS in state.js).
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
            // Weeks this team sat out: a playoff BYE. Not a game, so it belongs in no W-L-T record, but the team still played real games that week and its points still count.
            weeklyBye: {},
            // Roto standings, straight off the payload and never recomputed (B31-FULL). ESPN owns this math including its own tie handling, which is why per-category points arrive as halves when teams tie a category. Verified on both FGB captures. sum(pointsByStat) equals points exactly, and the scored ids with nonzero points are exactly the league's scoringItems ids. Empty objects for every non-roto league, which never reads them.
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

                // Any bracket tier other than the winners bracket is a consolation ladder - those teams are no longer playing for the actual championship. Tag every played week with its tier so bar/line charts can be broken down by it.
                let tier = 'reg';
                if (game.playoffTierType && game.playoffTierType !== 'NONE') {
                    tier = (game.playoffTierType === 'WINNERS_BRACKET') ? 'playoff' : 'consolation';
                }
                teamDataMap[tId].weeklyTier[week] = tier;

                // A playoff BYE is a schedule entry with only ONE side. ESPN gives the resting team a game with no opponent and leaves winner UNDECIDED. VALIDATED against a real 2026 season whose champion had a bye in matchup 22 (four such entries, one per resting team, each with a home side, no away side, and real points scored). Every result line below reads "did this side win?", and UNDECIDED is not a win, so a bye was booking a LOSS against a team that never played - which is how a team that won every playoff game showed a playoff loss. Record no result at all: computeRecordByTier and the other tallies already skip a week with none. The points and per-category totals still land, because those games were played.
                const isBye = !game.home || !game.away;
                if (isBye) teamDataMap[tId].weeklyBye[week] = true;

                if (AppState.isPointsLeague) {
                    teamDataMap[tId].weeklyMatchWins[week] = game[side].totalPoints || 0;
                    // A points-league week still has a real winner - the higher-scoring side. Record that 1/0.5/0 result separately from the points total (which weeklyMatchWins holds so the Season Trends chart can plot a Points line), so the standings can show a genuine Match Wins record ALONGSIDE Points For instead of relabeling the points total as "match wins".
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

                        // Category wins are wins against an OPPONENT, so a bye has none to record. Writing a 0 here would read as losing every category that week.
                        const cWins = game[side].cumulativeScore?.wins || 0;
                        const cTies = game[side].cumulativeScore?.ties || 0;
                        teamDataMap[tId].weeklyCatWins[week] = cWins + (cTies * 0.5);
                    }
                }

                // Per-category weekly totals feed the heatmap and Category Rankings for EVERY league, points included - a points league still accumulates the same stat lines each week, it just scores them by points instead of category wins. This block used to live inside the category-only else above, so points leagues left weeklyCats empty and scoredCategoriesInRange's hasData filter dropped every column, blanking the heatmap. The points-specific weeklyMatchWins (totalPoints) assignment stays in the branch above; only the stat capture is shared.
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
            // Escaped at the source. These go into the dropdown's innerHTML below, and team names are set by league members - hostile markup in one must render as text.
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
        // Roto has no matchup periods and no live scoreboard behind them - the payload carries a single undecided placeholder entry - so this whole control stands down rather than reading "Week 1 | 0 Matchups" forever (B31-FULL).
        weekIndicator.style.display = AppState.isRotoLeague ? 'none' : '';
        // "Matchup", not "Week". currentWeek here IS status.currentMatchupPeriod, and this indicator sits on the same screen as graphs whose axes read M. It only ever renders for matchup leagues (hidden for roto just above), so the unit is theirs by construction.
        weekIndicator.innerHTML = `${axisUnit().long} ${currentWeek} <span style="color:#ccc; margin: 0 4px;">|</span> ${activeMatchups} Matchups ▾`;
        // A recap is a single matchup's story (both sides, category by category), which roto has no equivalent of - so the button goes quiet and says why rather than opening a modal with nothing to put in it.
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

    // Populate the year dropdown from the seasons this specific league (this sport + league ID) actually existed for - see fetchLeagueHistorySeasons in api.js. leagueHistory only covers completed past seasons, not the current/in-progress one, so also guarantee this real-world year is always selectable - otherwise a league whose current season hasn't been "historicized" yet loses its own active year entirely. Deliberately NOT adding next year too - ESPN 404s on a season that doesn't exist yet for this league.
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
    // My Team too, for the same reason the Team Metrics boxes re-render here. A fetch committed while that tab is the one on screen otherwise leaves the PREVIOUS league's roster sitting there, the stale-view rule applied to the third tab. resetMyTeamView above has already cleared the scouted team, so this redraws on the new league's own owner.
    renderMyTeamTab();

    // Start pulling the (big, ~5s) Player Metrics pool in the background right away, so the tab opens near-instantly when it's eventually clicked - see prefetchPlayerData.
    prefetchPlayerData();
}
