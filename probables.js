// Projected pitching starts. PURE, so no DOM, no AppState and no fetches, which keeps the counting
// rule unit-testable and stated in one place. The chain is all ESPN's own data: starterStatusByProGame
// marks each of a pitcher's games PROBABLE or NOTSTARTING, proGamesByScoringPeriod says which day a
// pro game falls on, and the league's own day-to-matchup history places that day in a matchup.
// VALIDATED against real payloads: every game id in the first resolves against the second, 3441 of
// 3441, and ESPN lists a full projected rotation up to 58 days ahead, so nothing here estimates one.

// Flattens the schedule response to gameId -> { period, date, home, away }, string-keyed because that is how the ids arrive. The date and both team ids ride along so a start can name its day and opponent without a second lookup.
export function buildGamePeriodIndex(scheduleResponse) {
    const index = new Map();
    const teams = (scheduleResponse && scheduleResponse.settings && scheduleResponse.settings.proTeams) || [];
    teams.forEach(team => {
        const byPeriod = team && team.proGamesByScoringPeriod;
        if (!byPeriod) return;
        Object.keys(byPeriod).forEach(period => {
            (byPeriod[period] || []).forEach(game => {
                if (!game || game.id == null) return;
                index.set(String(game.id), {
                    period: Number(game.scoringPeriodId ?? period),
                    date: game.date || null,
                    home: game.homeProTeamId ?? null,
                    away: game.awayProTeamId ?? null
                });
            });
        });
    });
    return index;
}

// proTeamId to abbreviation, from the same response.
export function buildProTeamAbbrevs(scheduleResponse) {
    const abbrevs = new Map();
    const teams = (scheduleResponse && scheduleResponse.settings && scheduleResponse.settings.proTeams) || [];
    teams.forEach(team => {
        if (team && team.id != null && team.abbrev) abbrevs.set(Number(team.id), String(team.abbrev).trim());
    });
    return abbrevs;
}

// How many DAYS a matchup runs, learned from the league's own completed matchups rather than assumed. Seven is common but not a rule: on a real league one matchup ran 14 days across the All-Star break while the league's own matchupPeriods still called it one week, so the history is the authority.
export function typicalMatchupLength(matchupMap) {
    if (!matchupMap || !matchupMap.byPeriod || !matchupMap.byPeriod.size) return 7;
    const lengths = new Map();
    const counts = new Map();
    matchupMap.byPeriod.forEach((mp, period) => {
        const seen = lengths.get(mp);
        if (!seen) lengths.set(mp, { min: period, max: period });
        else { seen.min = Math.min(seen.min, period); seen.max = Math.max(seen.max, period); }
    });
    // Only matchups BEFORE the current one are complete; the live one is still filling in.
    lengths.forEach((span, mp) => {
        if (matchupMap.currentMatchup && mp >= matchupMap.currentMatchup) return;
        const len = span.max - span.min + 1;
        counts.set(len, (counts.get(len) || 0) + 1);
    });
    let best = 0, bestLen = 7;
    counts.forEach((n, len) => { if (n > best) { best = n; bestLen = len; } });
    return bestLen;
}

// The day range of the matchup being played, as far as it can honestly be known. The start is a fact, the earliest day already filed under this matchup. The END cannot be read anywhere, since the payload never carries a day later than today and matchupPeriods is in week units a long matchup contradicts, so it is the typical length applied to the known start and never earlier than today.
export function currentMatchupWindow(matchupMap, todayPeriod) {
    if (!matchupMap || !matchupMap.byPeriod || !matchupMap.byPeriod.size) return null;
    const current = matchupMap.currentMatchup;
    if (!current) return null;
    let start = null;
    matchupMap.byPeriod.forEach((mp, period) => {
        if (mp === current && (start === null || period < start)) start = period;
    });
    // The matchup is live but no day has been filed under it yet, which is the morning it opens.
    if (start === null) start = Number(todayPeriod) || matchupMap.lastPeriod + 1;
    const end = Math.max(start + typicalMatchupLength(matchupMap) - 1, Number(todayPeriod) || start);
    return { matchup: current, start, end, assumedEnd: true };
}

// PROBABLE starts inside a day window, per player and totalled. Only PROBABLE counts, since NOTSTARTING is ESPN saying a listed turn is being skipped, which is exactly what a naive count of a pitcher's games gets wrong. Each entry carries the starts themselves so the table can name the day and opponent of each, sorted by day. A start on today's date counts as remaining, because the day is not over.
export function countProjectedStarts(pitchers, gameIndex, window, fromPeriod) {
    const byPlayer = new Map();
    let total = 0, remaining = 0;
    if (!window || !gameIndex || !gameIndex.size) return { byPlayer, total, remaining };
    const from = Number(fromPeriod) || window.start;
    (pitchers || []).forEach(p => {
        const games = p && p.starterStatusByProGame;
        if (!games) return;
        const starts = [];
        Object.keys(games).forEach(gameId => {
            if (games[gameId] !== 'PROBABLE') return;
            const game = gameIndex.get(String(gameId));
            if (!game || game.period < window.start || game.period > window.end) return;
            // Which side the pitcher is on decides the opponent, and the pool gives his proTeamId.
            const isHome = p.proTeamId != null && game.home === p.proTeamId;
            const opponentId = isHome ? game.away : game.home;
            starts.push({
                period: game.period,
                date: game.date || null,
                opponentId: opponentId ?? null,
                isHome,
                played: game.period < from
            });
        });
        if (starts.length) {
            starts.sort((a, b) => a.period - b.period);
            const left = starts.filter(s => !s.played).length;
            byPlayer.set(p.id, { starts: starts.length, remaining: left, games: starts });
            total += starts.length;
            remaining += left;
        }
    });
    return { byPlayer, total, remaining };
}
