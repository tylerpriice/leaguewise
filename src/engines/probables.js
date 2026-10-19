/**
 * Projected pitching starts for a matchup, and the calendar the pro schedule gives a league: which
 * day a scoring period is, which period a game falls in, how long a matchup runs, and the betting
 * line on a game.
 *
 * Everything is ESPN's own data: each pitcher's listed games, the season schedule that dates them,
 * and the league's own history of which day belongs to which matchup. No rotation is estimated.
 * Baseball only, since ESPN lists no projected starter for a hockey goalie.
 *
 * Pure, and it imports nothing. No DOM, no application state and no network.
 *
 * Tests: tests/features.test.html
 * @module probables
 */
/**
 * Pro games by id, as buildGamePeriodIndex returns them.
 *
 * @typedef {Map<string, {period: number, date: ?number, home: ?number, away: ?number, tbd: boolean}>} GameIndex
 */
/**
 * The league's history of which scoring period belongs to which matchup, built elsewhere in the
 * app.
 *
 * @typedef {object} MatchupMap
 * @property {Map<number, number>} byPeriod The matchup each scoring period was filed under.
 * @property {number} currentMatchup The matchup being played.
 * @property {number} lastPeriod The last scoring period on file.
 * @property {{start: number, end: number}} [currentSpan] The open matchup's own first and last day, when known.
 */

/**
 * The calendar date of each scoring period, from the pro schedule: the earliest game of the
 * period. Taking the earliest keeps an evening's games on that evening when the last of them ends
 * after midnight in UTC.
 *
 * @param {object} scheduleResponse ESPN's pro schedule response.
 * @returns {Map<number, number>} Each period's date, in epoch milliseconds.
 */
export function datesByScoringPeriod(scheduleResponse) {
    const byPeriod = new Map();
    const teams = (scheduleResponse && scheduleResponse.settings && scheduleResponse.settings.proTeams) || [];
    teams.forEach(team => {
        const games = team && team.proGamesByScoringPeriod;
        if (!games) return;
        Object.keys(games).forEach(key => {
            (games[key] || []).forEach(game => {
                if (!game || !game.date) return;
                const period = Number(game.scoringPeriodId ?? key);
                if (!Number.isFinite(period)) return;
                const at = Number(game.date);
                if (!Number.isFinite(at)) return;
                const held = byPeriod.get(period);
                if (held === undefined || at < held) byPeriod.set(period, at);
            });
        });
    });
    return byPeriod;
}

/**
 * Builds the function that names a scoring period's weekday, such as 'Tue'. A period with no date
 * is labelled with its own number.
 *
 * @param {Map<number, number>} datesByPeriod The dates from datesByScoringPeriod.
 * @returns {function(number): string} Labels a period.
 */
export function dayLabelerFor(datesByPeriod) {
    const cache = new Map();
    return (period) => {
        const p = Number(period);
        if (cache.has(p)) return cache.get(p);
        const at = datesByPeriod && typeof datesByPeriod.get === 'function' ? datesByPeriod.get(p) : null;
        let label = String(period);
        if (Number.isFinite(Number(at))) {
            const d = new Date(Number(at));
            if (!Number.isNaN(d.getTime())) label = d.toLocaleDateString(undefined, { weekday: 'short' });
        }
        cache.set(p, label);
        return label;
    };
}

/**
 * Flattens the pro schedule to one entry per game: its scoring period, its date and its two
 * clubs. The keys are strings, as game ids arrive on a player.
 *
 * @param {object} scheduleResponse ESPN's pro schedule response.
 * @returns {GameIndex} The games by id.
 */
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
                    away: game.awayProTeamId ?? null,
                    // Whether ESPN has yet to set the start time. Every such game in a period shares one placeholder time, which is not a day to place a game on.
                    tbd: game.startTimeTBD === true
                });
            });
        });
    });
    return index;
}

/**
 * Each pro club's abbreviation, from the schedule response.
 *
 * @param {object} scheduleResponse ESPN's pro schedule response.
 * @returns {Map<number, string>} The abbreviation by pro team id.
 */
export function buildProTeamAbbrevs(scheduleResponse) {
    const abbrevs = new Map();
    const teams = (scheduleResponse && scheduleResponse.settings && scheduleResponse.settings.proTeams) || [];
    teams.forEach(team => {
        if (team && team.id != null && team.abbrev) abbrevs.set(Number(team.id), String(team.abbrev).trim());
    });
    return abbrevs;
}

/**
 * How many days a matchup usually runs, taken from the league's own completed matchups: the most
 * common length. A week of seven days is common and is not a rule.
 *
 * @param {MatchupMap} matchupMap The league's day-to-matchup history.
 * @returns {number} The length in days; 7 with no history.
 */
export function typicalMatchupLength(matchupMap) {
    if (!matchupMap || !matchupMap.byPeriod || !matchupMap.byPeriod.size) return 7;
    const lengths = new Map();
    const counts = new Map();
    matchupMap.byPeriod.forEach((mp, period) => {
        const seen = lengths.get(mp);
        if (!seen) lengths.set(mp, { min: period, max: period });
        else { seen.min = Math.min(seen.min, period); seen.max = Math.max(seen.max, period); }
    });
    // Only matchups before the current one are complete.
    lengths.forEach((span, mp) => {
        if (matchupMap.currentMatchup && mp >= matchupMap.currentMatchup) return;
        const len = span.max - span.min + 1;
        counts.set(len, (counts.get(len) || 0) + 1);
    });
    let best = 0, bestLen = 7;
    counts.forEach((n, len) => { if (n > best) { best = n; bestLen = len; } });
    return bestLen;
}

/**
 * The day range of the matchup being played. The start is the earliest day filed under it. The
 * end is the league's own span where the map carries one, and otherwise the usual length from the
 * start. It is never earlier than today.
 *
 * @param {MatchupMap} matchupMap The league's day-to-matchup history.
 * @param {number} todayPeriod The present scoring period.
 * @returns {?{matchup: number, start: number, end: number, assumedEnd: boolean}} The window, with assumedEnd true when the end came from the usual length. Null before the season has a day on file.
 */
export function currentMatchupWindow(matchupMap, todayPeriod) {
    if (!matchupMap || !matchupMap.byPeriod || !matchupMap.byPeriod.size) return null;
    const current = matchupMap.currentMatchup;
    if (!current) return null;
    let start = null;
    matchupMap.byPeriod.forEach((mp, period) => {
        if (mp === current && (start === null || period < start)) start = period;
    });
    // The matchup is open and no day has been filed under it yet, which is the morning it starts.
    if (start === null) start = Number(todayPeriod) || matchupMap.lastPeriod + 1;

    // The league's own span first, and the usual length only as a fallback. The usual length comes from completed matchups and cannot see a playoff round that runs longer. The span travels on the map, since this file imports nothing.
    const span = matchupMap.currentSpan;
    if (span && Number.isFinite(span.end) && span.start === start) {
        return { matchup: current, start, end: Math.max(span.end, Number(todayPeriod) || start), assumedEnd: false };
    }
    const end = Math.max(start + typicalMatchupLength(matchupMap) - 1, Number(todayPeriod) || start);
    return { matchup: current, start, end, assumedEnd: true };
}

/**
 * Flattens ESPN's scoreboard to the moneyline for each game, keyed by the scoreboard's event id,
 * which is the pro schedule's game id. Only the first provider's line is kept, with the provider's
 * name so it can be credited wherever the number is shown.
 *
 * @param {object} scoreboardResponse ESPN's scoreboard response.
 * @returns {Map<string, {home: ?string, away: ?string, provider: ?string, homeFavored: ?boolean}>} The line by game id. A game with no line is absent, which is the usual case.
 */
export function buildOddsIndex(scoreboardResponse) {
    const index = new Map();
    const events = (scoreboardResponse && scoreboardResponse.events) || [];
    events.forEach(event => {
        if (!event || event.id == null) return;
        const competition = (event.competitions || [])[0];
        const entry = competition && Array.isArray(competition.odds) ? competition.odds[0] : null;
        if (!entry) return;
        // Strings with their sign, taken from the closing line as it stands.
        const priceOf = (which) => {
            const side = entry.moneyline && entry.moneyline[which];
            const value = side && side.close && side.close.odds;
            return (typeof value === 'string' && value.trim()) ? value.trim() : null;
        };
        const home = priceOf('home');
        const away = priceOf('away');
        if (!home && !away) return;
        index.set(String(event.id), {
            home,
            away,
            provider: (entry.provider && entry.provider.name) || null,
            homeFavored: entry.homeTeamOdds ? entry.homeTeamOdds.favorite === true : null
        });
    });
    return index;
}

/**
 * The moneyline for one side of one game.
 *
 * @param {Map<string, object>} oddsIndex The index from buildOddsIndex.
 * @param {string|number} gameId The game.
 * @param {boolean} isHome Whether the side wanted is the home side.
 * @returns {?{price: string, provider: ?string, favored: ?boolean}} Null when there is no line, which a caller shows as nothing at all.
 */
export function moneylineFor(oddsIndex, gameId, isHome) {
    const line = oddsIndex && oddsIndex.get(String(gameId));
    if (!line) return null;
    const price = isHome ? line.home : line.away;
    if (!price) return null;
    const favored = line.homeFavored === null || line.homeFavored === undefined
        ? null
        : (isHome ? line.homeFavored : !line.homeFavored);
    return { price, provider: line.provider, favored };
}

/**
 * Counts each pitcher's probable starts inside a window of days. Only a game ESPN lists as
 * probable counts; a listed turn marked as not starting is a skipped one. A start on the present
 * day counts as remaining.
 *
 * @param {Array<{id: number, proTeamId: number, starterStatusByProGame: Object<string, string>}>} pitchers The pitchers.
 * @param {GameIndex} gameIndex Pro games by id.
 * @param {{start: number, end: number}} window The first and last scoring period.
 * @param {number} fromPeriod The present scoring period.
 * @returns {{byPlayer: Map<number, {starts: number, remaining: number, games: Array<{id: string, period: number, date: ?number, teamId: ?number, opponentId: ?number, isHome: boolean, played: boolean}>}>, total: number, remaining: number}}
 *   Each pitcher's starts in day order, and the totals. A pitcher with none is absent.
 */
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
            // Which side the pitcher is on decides the opponent.
            const isHome = p.proTeamId != null && game.home === p.proTeamId;
            const opponentId = isHome ? game.away : game.home;
            starts.push({
                id: String(gameId),
                period: game.period,
                date: game.date || null,
                // The pitcher's own club is carried beside the opponent's, since a home start is played in that park. Null means the side could not be established.
                teamId: p.proTeamId ?? null,
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
