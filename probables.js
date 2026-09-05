// Projected pitching starts. PURE - no DOM, no AppState, no fetches, so the counting rule is unit-testable and stated in one place rather than scattered through a render. The chain, all of it ESPN's own data: starterStatusByProGame a pitcher's games, each PROBABLE or NOTSTARTING (player pool) proGamesByScoringPeriod which day each pro game falls on (season schedule) the league's own day-to-matchup history VALIDATED: every game id in the first resolves against the second, 3441 of 3441, and ESPN lists a full projected rotation up to 58 days ahead. Nothing here estimates a rotation. BASEBALL ONLY, AND NOW MEASURED RATHER THAN ASSUMED. The September captures settle whether the same chain could name a hockey GOALIE start: it cannot, because the first link does not exist there. starterStatusByProGame is carried by 2,817 of the 3,000 players in the baseball pool and by ZERO of 1,713 and ZERO of 1,655 in the two hockey pools. Two independent hockey leagues, two seasons, not one player - so this is ESPN declining to publish a projected goalie, not a capture that missed a field. A hockey equivalent therefore cannot be a PROJECTION off ESPN's own flag, and the fallback the audit named - a descriptive start share off NHL data - needs a source this project does not have permission for, so it stays behind the NHL terms ruling. Nothing to build here until that lands; this note exists so the next reader does not go looking for the flag again.

// Flattens the proTeamSchedules_wl response to gameId -> { period, date, home, away }. String keys throughout, because that is how the ids arrive in starterStatusByProGame. The date and the two team ids ride along so a start can name its day and its opponent without a second lookup. Both come off the same game object. SCORING PERIOD -> CALENDAR DATE, off the same schedule the probables machinery already reads. PURE. shipped chips labelled "Day 1, Day 2" because nothing in the LEAGUE payload dates a period, and the one candidate anchor was tested and rejected - standingsUpdateDate tracks the day mid-season and drifts by six days on a finished hockey league, so it is a last-touched timestamp rather than a date. The pro-team schedule has the real thing: every game carries its own date, and a scoring period is the day its games are played on. The EARLIEST game of a period is the period's date. A period holds a whole slate, and games run into the small hours of the next day in UTC - taking the earliest keeps a Tuesday slate on Tuesday instead of letting a 00:05 finish drag the label to Wednesday. (The same UTC edge showed up in the anchor test on opening day.)
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

// WHAT DAY A SCORING PERIOD WAS, ready to print - "Tue", "Sat". The row contract wants the label pre-formatted (the gpLabel convention: this lane owns formatting, the renderer owns layout), and this is the only module that knows a period's date, so it is the only one that can answer. Returns a FUNCTION rather than a map because the caller asks it once per day per player and a closure over the map costs nothing, while re-deriving the date per row would cost a Date parse three thousand times over. A period the schedule has no date for falls back to its own number rather than an empty label: a column reading "12" is odd, a column reading nothing is broken.
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

// proTeamId -> abbreviation, from the same response. This is the map ROADMAP Decision #18 recorded as missing when it ruled real team logos out, so it is worth knowing it lives here.
export function buildProTeamAbbrevs(scheduleResponse) {
    const abbrevs = new Map();
    const teams = (scheduleResponse && scheduleResponse.settings && scheduleResponse.settings.proTeams) || [];
    teams.forEach(team => {
        if (team && team.id != null && team.abbrev) abbrevs.set(Number(team.id), String(team.abbrev).trim());
    });
    return abbrevs;
}

// How many DAYS a matchup runs, learned from the league's own completed matchups rather than assumed. A 7-day week is the common case but not a rule. Measured on a real 2026 league, matchup 15 ran 14 days across the All-Star break while the league's own matchupPeriods still called it one week. So the league's history is the authority and ESPN's stated week count is not.
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

// The day range of the matchup being played, as far as it can honestly be known. The start is a fact: the earliest day the league has already filed under this matchup. The END cannot be read anywhere - the payload never carries a day later than today (checked across twelve captures), and ESPN's matchupPeriods is in week units that a long matchup contradicts. So the end is the typical length applied to the known start, and never earlier than today, so a matchup running longer than usual keeps counting instead of collapsing to zero. Returns null when the league has no day history yet, which is a season that has not started.
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

    // THE LEAGUE'S OWN SPAN FIRST, THE MODAL LENGTH ONLY AS A FALLBACK. The fallback below is the modal length of the league's COMPLETED matchups, and a playoff round is exactly the case it cannot see: measured on a live 2026 baseball league, twenty of its twenty-two completed rounds ran seven days so the modal length is 7, while the round being played runs FOURTEEN. This window therefore ended on day 166 of a round running to 173, and a pitcher with a listed start on day 167 read "1 start, 0 left" - his Monday reported as not happening, which is the owner's own report. buildMatchupPeriodMap works the real span out from the league's week counts and its final day and carries it as `currentSpan` (utils.js spanOfOpenMatchup). It is read here rather than re-derived, because two modules computing "how long is this matchup" is what produced the defect. This file imports nothing, deliberately, so the answer travels on the map.
    const span = matchupMap.currentSpan;
    if (span && Number.isFinite(span.end) && span.start === start) {
        return { matchup: current, start, end: Math.max(span.end, Number(todayPeriod) || start), assumedEnd: false };
    }
    const end = Math.max(start + typicalMatchupLength(matchupMap) - 1, Number(todayPeriod) || start);
    return { matchup: current, start, end, assumedEnd: true };
}

// PROBABLE starts inside a day window, per player and totalled. Only PROBABLE counts. NOTSTARTING is ESPN saying a listed turn is being skipped, which is exactly the case a naive "count the games" would get wrong. `fromPeriod` splits what is left from what has already happened. A start on today's date counts as remaining, because the day is not over. pitchers: [{ id, starterStatusByProGame }] Each player's entry carries the starts themselves, not just a count, so the table can name the day and the opponent of each one. Sorted by day, since that is the order they will happen in. The scoreboard's odds flattened to gameId -> the one line worth showing. VALIDATED against live captures. The scoreboard's EVENT id is the pro-schedule GAME id, 15 of 15 on each of five dates, so this joins on the id and never on date+teams. See DATA-SOURCES 6a, which also records that odds exist for ESPN's current slate ONLY - so a miss here is the normal case for almost every card, not a fault. Only the moneyline is kept. It answers the same question the difficulty score asks - how likely is this pitcher's side to win - while the spread and the total answer different ones, and a card has room for one number. The odds array carries one entry per provider; the first is the one shown, and its name rides along because rule 4 requires the credit wherever the number renders.
export function buildOddsIndex(scoreboardResponse) {
    const index = new Map();
    const events = (scoreboardResponse && scoreboardResponse.events) || [];
    events.forEach(event => {
        if (!event || event.id == null) return;
        const competition = (event.competitions || [])[0];
        const entry = competition && Array.isArray(competition.odds) ? competition.odds[0] : null;
        if (!entry) return;
        // Strings, sign included ("-158", "+131"), and taken from `close` - the line as it stands.
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

// The line for ONE pitcher's own side of that game, which is the only form the card wants. Null whenever there is no line, which the caller must render as nothing at all rather than as a dash or a zero - an absent line is the normal state of a start more than a day out.
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
            // Which side the pitcher is on decides the opponent, and the pool gives the proTeamId.
            const isHome = p.proTeamId != null && game.home === p.proTeamId;
            const opponentId = isHome ? game.away : game.home;
            starts.push({
                id: String(gameId),
                period: game.period,
                date: game.date || null,
                // The pitcher's OWN club rides along beside the opponent's, because a home start is played in that park and the difficulty engine has to be able to name it. It also records what `isHome` was decided from. Null here means the side is a guess, not a fact.
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
