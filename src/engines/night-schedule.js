/**
 * The night schedule: schedule-insight.js's count of who plays each night, resolved into named
 * players with their opponents, for a calendar of skaters and goalies. It also lists who is idle
 * each night, which is the question a sport that plays almost daily asks.
 *
 * It consumes rosterNightCoverage's result and counts nothing again. Whether a period is a day or
 * a week is decided by the periods the caller built the coverage over.
 *
 * Pure. No DOM, no application state and no network.
 *
 * Contract: tests/fixtures/night-schedule.md
 * Tests: tests/night-schedule.test.html
 * @module night-schedule
 */
/**
 * Resolves a roster's night coverage into named players per night, each with the opponent, the
 * side and the game's own time, and lists the players idle that night.
 *
 * @param {{byPeriod: Array<{period: number, playing: number, idle: number, emptySlots: ?number, playerIds: Array}>, players: number, unknownClub: number, fewestPlaying: number}} coverage The coverage from schedule-insight.js's rosterNightCoverage.
 * @param {Map<*, {name: string, proTeamId: number, proGamePlayerDetail: (object|undefined)}>} rosterById The roster's players by id.
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {Array} rosterIds The same ids the coverage was built from.
 * @returns {?{byPeriod: Array<{period: number, players: object[], idlePlayers: object[], playing: number, idle: number, emptySlots: ?number}>, players: number, unknownClub: number, fewestPlaying: number, lightestPeriod: ?number}}
 *   One row per night. The game's time is the raw timestamp, for the caller to format. Null for
 *   no coverage.
 */
export function buildNightSchedule(coverage, rosterById, proTeams, rosterIds) {
    if (!coverage || !coverage.byPeriod || !coverage.byPeriod.length) return null;

    // A club's first game on a period is taken as its game that period. Each club's games are indexed by period, with the opponent, the side, the game id and the date.
    const gameOf = new Map();
    (proTeams || []).forEach(team => {
        if (!team || team.id == null || Number(team.id) === 0) return;
        const id = Number(team.id);
        const byPeriod = new Map();
        const sched = team.proGamesByScoringPeriod || {};
        Object.keys(sched).forEach(k => {
            const games = sched[k] || [];
            if (!games.length) return;
            const g = games[0];
            const opponentId = Number(g.homeProTeamId) === id ? g.awayProTeamId : g.homeProTeamId;
            byPeriod.set(Number(k), { opponentId, isHome: Number(g.homeProTeamId) === id, gameId: g.id ?? null, date: g.date ?? null });
        });
        gameOf.set(id, byPeriod);
    });

    // Known means the player's club is in the schedule. A player whose club cannot be placed is neither playing nor idle, as in the coverage's own count.
    const knownIds = (rosterIds || []).filter(id => {
        const p = rosterById && typeof rosterById.get === 'function' ? rosterById.get(id) : null;
        return p && gameOf.has(Number(p.proTeamId));
    });

    const byPeriod = coverage.byPeriod.map(day => {
        const playingSet = new Set(day.playerIds || []);
        const players = (day.playerIds || []).map(id => {
            const p = rosterById && typeof rosterById.get === 'function' ? rosterById.get(id) : null;
            if (!p) return null;
            const teamGames = gameOf.get(Number(p.proTeamId));
            const game = teamGames ? teamGames.get(day.period) : null;
            // The expected start and the batting order come from ESPN's own detail for the player's game. They are passed through and score nothing: they say whether a player plays, not how hard the night is.
            const detail = game && game.gameId != null && p.proGamePlayerDetail
                ? p.proGamePlayerDetail[String(game.gameId)]
                : null;
            return {
                id,
                name: p.name || 'Unknown',
                opponentId: game ? game.opponentId : null,
                isHome: game ? game.isHome : null,
                starterStatus: detail && detail.starterStatus ? detail.starterStatus : null,
                lineupOrder: detail && detail.lineupOrder != null ? detail.lineupOrder : null,
                gameDate: game && game.date != null ? game.date : null
            };
        }).filter(Boolean);
        // The idle players are listed, not only counted: the known roster less the players on tonight, each with an id, a name and a club.
        const idlePlayers = knownIds
            .filter(id => !playingSet.has(id))
            .map(id => {
                const p = rosterById.get(id);
                return { id, name: p.name || 'Unknown', proTeamId: p.proTeamId ?? null };
            });
        return { period: day.period, players, idlePlayers, playing: day.playing, idle: day.idle, emptySlots: day.emptySlots };
    });

    // The first night, in period order, at the fewest playing. Against a fixed roster it is also the night with the most idle.
    const lightestPeriod = (byPeriod.find(d => d.playing === coverage.fewestPlaying) || {}).period ?? null;

    return { byPeriod, players: coverage.players, unknownClub: coverage.unknownClub, fewestPlaying: coverage.fewestPlaying, lightestPeriod };
}
