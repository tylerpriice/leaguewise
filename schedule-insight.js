import { countProjectedStarts } from './probables.js';

// PURE. No DOM, no AppState, no fetches - and, the point of this one, NO NEW REQUESTS. Every function here reads the pro-team schedule view and the league payload the app has already fetched. Nothing below can make the extension ask ESPN for anything it was not already asking for. --------------------------------------------------------------------------------------------- THE FIELD THAT LOOKS RIGHT AND IS NOT --------------------------------------------------------------------------------------------- A matchup's days do NOT come from settings.scheduleSettings.matchupPeriods. That field looks exactly like the answer - it is keyed by matchup and its values are lists of numbers - and it is a different unit. MEASURED on three real leagues: its values run 1..25 while the pro-team schedule and the league's own pointsByScoringPeriod both run 1..192. It maps a matchup to WEEK indices, not to days. Slicing a pro-team schedule with it would read days 22 and 23 for matchup 22 and report two games where a club played six, wrong by a factor of seven and plausible enough to ship. The real day-to-matchup map is the league's own schedule, via utils.js buildMatchupPeriodMap - the same map the weekly pipeline already buckets stats with, which is what makes these counts agree with the numbers everywhere else in the app. Callers pass the DAYS in; this file never guesses at them.

// ==== How many games a club plays inside a stretch of days ====

// The atom the playoff-density question is built from, and it is sport-generic: a set of scoring periods in, every pro team's game count out. proTeams: scheduleResponse.settings.proTeams (already fetched for the Schedule face) periods: the scoring period ids of one matchup, from periodsOfMatchup A team absent from the result played NOTHING in that stretch, which is a real answer and the one that matters most for a playoff week - a club on a bye is exactly what a manager is looking for. It is reported as a zero-count entry rather than an absence, so a caller listing every club does not have to know which clubs exist.
export function gamesByProTeamForMatchup(proTeams, periods) {
    const wanted = new Set((periods || []).map(Number).filter(Number.isFinite));
    const out = new Map();
    (proTeams || []).forEach(team => {
        if (!team || team.id == null) return;
        // ESPN's free-agent pseudo-club has an id and no schedule. It is not a club.
        if (Number(team.id) === 0) return;
        const byPeriod = new Map();
        let games = 0;
        const sched = team.proGamesByScoringPeriod || {};
        Object.keys(sched).forEach(period => {
            const p = Number(period);
            if (!wanted.has(p)) return;
            const n = (sched[period] || []).length;
            if (!n) return;
            byPeriod.set(p, n);
            games += n;
        });
        out.set(Number(team.id), { games, byPeriod });
    });
    return out;
}

// The same question for several matchups at once, which is the shape the playoff read wants: how many games does this club play in each round. matchups: [{ matchup, periods }]
export function densityAcrossMatchups(proTeams, matchups) {
    const rows = [];
    (matchups || []).forEach(m => {
        if (!m || m.matchup == null) return;
        rows.push({
            matchup: Number(m.matchup),
            periods: (m.periods || []).length,
            byTeam: gamesByProTeamForMatchup(proTeams, m.periods)
        });
    });
    rows.sort((a, b) => a.matchup - b.matchup);
    return rows;
}

// ONE PLAYER'S PLAYOFF WINDOW, in the shape the leaderboard row's contract asks for: { games, byRound: [{ matchup, games, days }], projected, trend } or null. DAYS RIDE ON EVERY ROUND, not just the odd one out. ESPN folds the tail of the pro season into the final round - measured on a real hockey league, matchups 22 and 23 run 7 days each and 24 runs EIGHTEEN - so "9 games in 24" against "3 in 22" is a club that is LESS busy per day, not three times as busy. Whether the renderer mentions the lengths is its decision to make, and it can only make it if it can compare them, so the contract requires them everywhere rather than only where they differ. NULL, NEVER A ZERO LINE, for a club this schedule does not know. A player with no pro club, or one whose club is absent from the capture, would otherwise come back as every round zero and a projection of nothing - a figure that looks measured and is not. A club that IS here and has no game in one round is a different fact, and that round honestly reads 0. `perGame` is the player's own projection and arrives as an argument: this module knows about schedules, not about players, and asking it to find a projection would be the seam that makes it impure. A player without one keeps their real game counts and reports `projected: null` rather than surrendering the whole column - the counts are the half that is still true.
export function playoffOutlook(rows, proTeamId, { perGame = null, trend = null } = {}) {
    if (!rows || !rows.length) return null;
    const id = Number(proTeamId);
    if (!Number.isFinite(id)) return null;
    // Map (live, from densityAcrossMatchups) or a plain object (the serialized fixture) - the same rows either way, and a reader of the fixture should not have to rebuild Maps to use them.
    const gamesIn = (byTeam) => {
        if (!byTeam) return null;
        const v = (typeof byTeam.get === 'function') ? byTeam.get(id) : (byTeam[id] ?? byTeam[String(id)]);
        if (v === null || v === undefined) return null;
        return Number.isFinite(Number(v.games)) ? Number(v.games) : Number(v);
    };
    const raw = rows.map(r => ({ matchup: Number(r.matchup), games: gamesIn(r.byTeam), days: Number(r.periods) || 0 }));
    if (raw.every(r => r.games === null)) return null;   // a club this schedule has never heard of
    const byRound = raw.map(r => ({ ...r, games: r.games === null ? 0 : r.games }));
    const games = byRound.reduce((sum, r) => sum + r.games, 0);
    // Number(null) is 0, so the null check comes BEFORE the coercion. Written the other way round this reported a projection of exactly 0.0 for every player without one - a figure that ranks, sorts and prints like a measurement.
    const pg = (perGame === null || perGame === undefined) ? null : Number(perGame);
    return {
        games,
        byRound,
        projected: (pg !== null && Number.isFinite(pg)) ? pg * games : null,
        trend: trend || null
    };
}

// ONE PLAYER'S CURRENT (or NEXT) MATCHUP: how many games that club plays in it, how many are already gone, and how many are left to set a lineup against. REMAINING IS THE POINT. "Four games this matchup" is a fact about the past by Thursday; the question a manager is actually asking on Thursday is how many are LEFT. So the split is carried rather than the total alone, and byPeriod rides along because a manager choosing between two players wants to know WHICH days, not just how many. `fromPeriod` is today, and a game on today's day counts as REMAINING - the day is not over. Same rule countProjectedStarts already uses for a start on today's date, so the two halves of this column can never disagree about what today means. NULL for a club the schedule does not carry; games: 0 for a club it does carry that is not playing. A football bye is the second of those and is a real answer - one game a matchup is that sport's normal, and none is the exception worth showing, not a reason to blank the column. `starts` is passed IN rather than computed: only baseball has probable pitchers, only pitchers have them, and this module knows about schedules rather than about who is a pitcher. Hockey and football pass null, which is not the same as 0 - a skater has no starts to count, and a pitcher with none listed has zero. `countStarts` switches the UNIT this window counts in. Off, the figures are the club's games, which is what a batter's window has always been. On - the caller having established that this player is a starting pitcher and that ESPN has listed the whole window - the same figures count his STARTS, and `unit` says so, because "9 of 13" and "1 of 2" are answers to different questions and a reader cannot tell them apart from the numbers alone.
export function matchupWindow(byTeam, proTeamId, { matchup = null, periods = null, labelOf = null, fromPeriod = null, starts = null, density = null, offNightShare = 1 / 3, countStarts = false } = {}) {
    const id = Number(proTeamId);
    if (!byTeam || !Number.isFinite(id)) return null;
    const entry = (typeof byTeam.get === 'function') ? byTeam.get(id) : (byTeam[id] ?? byTeam[String(id)]);
    if (entry === null || entry === undefined) return null;   // a club this schedule has never heard of

    const perPeriod = entry.byPeriod
        ? (typeof entry.byPeriod.get === 'function' ? [...entry.byPeriod.entries()] : Object.entries(entry.byPeriod))
        : [];
    const countByPeriod = new Map();
    perPeriod.forEach(([period, count]) => {
        const p = Number(period);
        if (Number.isFinite(p)) countByPeriod.set(p, Number(count) || 0);
    });

    // EVERY DAY THE WINDOW COVERS, not only the days this club plays. An idle day is a real entry with a count of 0 - the reader is choosing between players, and "off on Wednesday" is the half of the answer that a list of only the game days cannot give. Falls back to the days the club does play when the caller does not say what the window spans, which is the most this function can honestly know on its own.
    const days = (periods && periods.length)
        ? [...periods].map(Number).filter(Number.isFinite)
        : [...countByPeriod.keys()].sort((a, b) => a - b);

    // THE LABEL IS PRE-FORMATTED HERE because the renderer owns layout and this lane owns formatting - the gpLabel convention. labelOf arrives as an argument rather than this module reaching for a date: schedule-insight counts games, probables.js knows what day a period was.
    const byPeriod = days.map(p => ({
        period: labelOf ? labelOf(p) : String(p),
        count: countByPeriod.get(p) || 0
    }));

    const games = Number.isFinite(Number(entry.games)) ? Number(entry.games) : [...countByPeriod.values()].reduce((s, c) => s + c, 0);
    // Number(null) is 0, and a null fromPeriod means "no idea what day it is" - which must not read as day zero, or every game in the window would count as already played.
    const from = (fromPeriod === null || fromPeriod === undefined) ? null : Number(fromPeriod);
    const played = (from === null || !Number.isFinite(from))
        ? 0
        : [...countByPeriod.entries()].filter(([p]) => p < from).reduce((s, [, c]) => s + c, 0);

    // THE GAMES THAT WIN A WEEK. Two counts a manager acts on that a bare total hides, both about WHEN the games fall rather than how many there are. offNight counts GAMES, not nights - the owner's own legend says "games on nights fewer than a third of clubs play" - so a club playing twice on a quiet night contributes two. The threshold arrives as a share rather than a number because the divisor is the league's club count, which differs by sport (32 in the NHL, 30 in MLB) and would otherwise be a magic number that silently means something different in each. NULL WHEN THE LEAGUE-WIDE DENSITY IS NOT SUPPLIED, and this is the emptySlots rule again: a 0 would say "none of these games fall on a quiet night", where the truth is that nobody said which nights are quiet. A REAL 0 is a real answer and the renderer omits it - "plays no off-night" is worth knowing and is not worth a chip.
    const dayCounts = density && density.byPeriod
        ? new Map(density.byPeriod.map(d => [Number(d.period), Number(d.teamsPlaying) || 0]))
        : null;
    const clubCount = density && Number(density.clubCount) > 0 ? Number(density.clubCount) : 0;
    const offNight = (dayCounts && clubCount)
        ? [...countByPeriod.entries()]
            .filter(([p]) => dayCounts.has(p) && dayCounts.get(p) < clubCount * offNightShare)
            .reduce((sum, [, c]) => sum + c, 0)
        : null;

    // twoGameDays counts DAYS, not games - a doubleheader is one day worth two, and the reader is choosing a player for a lineup slot that fills once a day. It needs no league-wide table, so it is never null while there is a window at all.
    const twoGameDays = [...countByPeriod.values()].filter(c => c >= 2).length;

    // COUNTED IN STARTS, when the caller has established this player is one and that ESPN has listed the whole window. The club's games are the wrong quantity for a starting pitcher by roughly five to one - the leaderboard told a manager his ace had "9 of 13 games left" in a matchup he appears in twice - and the honest figure is the one ESPN has already published for the two-start badges. offNight and twoGameDays go NULL here rather than carrying over: both count the club's games, and a start on a quiet night or a club's doubleheader says nothing about a pitcher who takes one turn in the window. A figure that means something else under the same name is the whole defect this option exists to fix, so it is not repeated in the fields beside it.
    const counted = !!(countStarts && starts);
    const total = counted ? (Number(starts.total) || 0) : games;
    const before = counted ? total - (Number(starts.remaining) || 0) : played;

    return {
        matchup: matchup === null || matchup === undefined ? null : Number(matchup),
        games: total,
        played: before,
        // played + remaining === games is this lane's invariant to keep, so remaining is DERIVED from the pair rather than counted separately - two counts of the same thing are two chances to disagree.
        remaining: total - before,
        // What the three counts above are counting. 'games' is every existing caller, unchanged.
        unit: counted ? 'starts' : 'games',
        offNight: counted ? null : offNight,
        twoGameDays: counted ? null : twoGameDays,
        byPeriod,
        starts: starts || null
    };
}

// One club's line across those matchups, ready to be read out.
export function teamDensity(rows, proTeamId) {
    const id = Number(proTeamId);
    return (rows || []).map(r => ({
        matchup: r.matchup,
        games: (r.byTeam.get(id) || { games: 0 }).games
    }));
}

// ==== Off nights ====

// How many clubs play on each day of a stretch. The hockey question underneath it is "will my lineup be half empty that night", and the honest form of the answer is a COUNT of clubs, not a percentage - four clubs playing is a fact, "12.5% of the league" is the same fact wearing a costume, and the house rule is no invented precision. `clubs` rides along per day because the caller usually wants to ask whether one particular club is among them, and recomputing that from a count is impossible.
export function offNightsForMatchup(proTeams, periods) {
    const days = (periods || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const clubIds = (proTeams || [])
        .filter(t => t && t.id != null && Number(t.id) !== 0)
        .map(t => Number(t.id));
    const byPeriod = days.map(period => {
        const clubs = [];
        (proTeams || []).forEach(team => {
            if (!team || team.id == null || Number(team.id) === 0) return;
            const games = (team.proGamesByScoringPeriod || {})[period] || [];
            if (games.length) clubs.push(Number(team.id));
        });
        return { period, teamsPlaying: clubs.length, clubs };
    });
    const counts = byPeriod.map(d => d.teamsPlaying);
    return {
        byPeriod,
        clubCount: clubIds.length,
        lightest: counts.length ? Math.min(...counts) : 0,
        heaviest: counts.length ? Math.max(...counts) : 0
    };
}

// ==== Off nights, from the roster's own side ====

// HOW MANY OF *MY* PLAYERS PLAY TONIGHT. offNightsForMatchup above answers the league-wide shape - how many CLUBS are on tonight - and that is the wrong unit for the decision a hockey manager actually makes. Ten clubs playing is a quiet night for the league and a disaster only if none of them is mine; six clubs is a light night that can still fill my lineup. The question is how many of the players I HOLD are on, and the only thing that can answer it is the roster. `roster` is [{ id, proTeamId }] - whatever subset the caller cares about, so My Team can ask it of skaters and goalies separately rather than this module inventing a position model it has no business owning. A PLAYER WITH NO CLUB IS COUNTED SEPARATELY, never as idle. A free-agent slot or a player the schedule does not carry is not a player sitting out; reporting that row as idle would say the lineup has a hole where it actually has an unknown, and those call for different actions.
export function rosterNightCoverage(roster, proTeams, periods, { slots = null } = {}) {
    const days = (periods || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!days.length) return null;

    // One pass over the clubs rather than one per night: a club's whole season is walked once.
    const playsOn = new Map();
    (proTeams || []).forEach(team => {
        if (!team || team.id == null || Number(team.id) === 0) return;   // the free-agent pseudo-club
        const sched = team.proGamesByScoringPeriod || {};
        const set = new Set();
        Object.keys(sched).forEach(k => { if ((sched[k] || []).length) set.add(Number(k)); });
        playsOn.set(Number(team.id), set);
    });

    const held = (roster || []).filter(p => p && p.id !== undefined);
    const unknownClub = held.filter(p => !playsOn.has(Number(p.proTeamId))).length;
    const known = held.filter(p => playsOn.has(Number(p.proTeamId)));

    const byPeriod = days.map(period => {
        const playing = known.filter(p => playsOn.get(Number(p.proTeamId)).has(period));
        return {
            period,
            playing: playing.length,
            // Idle is measured against the players whose club the schedule KNOWS, so an unknown never inflates the hole it is not evidence of.
            idle: known.length - playing.length,
            // WHAT THE LINEUP CANNOT FILL, which is the number a manager acts on: eight players on tonight is comfortable with six slots and a shortfall with twelve. NULL when the caller did not say how many slots there are - an unstated capacity is unknown, not zero, and zero would read as "your lineup is full" on a night nobody checked. Floored at zero: more players than slots is a choice to make, not an emptiness.
            emptySlots: (slots === null || slots === undefined) ? null : Math.max(0, Number(slots) - playing.length),
            playerIds: playing.map(p => p.id)
        };
    });

    const counts = byPeriod.map(d => d.playing);
    return {
        byPeriod,
        players: known.length,
        unknownClub,
        thinnest: Math.min(...counts),
        fullest: Math.max(...counts)
    };
}

// WHICH NIGHTS A FREE AGENT WOULD ACTUALLY FILL - not which nights they play, which is a different and much less useful number. A skater who plays four nights fills none of them if the lineup was already full on all four; the value of an add is the intersection of that schedule with MY holes. `fills` is null rather than empty when the coverage was built without a slot count: with no capacity there is no way to know what a hole is, and an empty list would say "fills nothing" when the honest answer is "nobody said how many slots there are".
export function nightsFilledBy(candidate, proTeams, coverage) {
    if (!candidate || !coverage || !coverage.byPeriod) return null;
    const id = Number(candidate.proTeamId);
    const team = (proTeams || []).find(t => t && t.id != null && Number(t.id) === id && Number(t.id) !== 0);
    if (!team) return null;                       // a club this schedule has never heard of
    const sched = team.proGamesByScoringPeriod || {};
    const playsOn = (period) => ((sched[period] || sched[String(period)] || []).length > 0);

    const plays = coverage.byPeriod.filter(d => playsOn(d.period)).map(d => d.period);
    const known = coverage.byPeriod.every(d => d.emptySlots !== null && d.emptySlots !== undefined);
    const fills = known ? coverage.byPeriod.filter(d => d.emptySlots > 0 && playsOn(d.period)).map(d => d.period) : null;
    return { plays, fills, fillCount: fills ? fills.length : null };
}

// THE LEADERBOARD ROW'S OPEN-SEAT FIELD. A thin refusal layer over nightsFilledBy above, kept here beside the atom it wraps rather than in the row model, so the rules about WHEN the question is answerable stay with the data that answers it. THE NAME IS DELIBERATELY "OPEN SEATS" AND NOT "FILLS". Coverage is built per ROLE GROUP with a single slot count, so an open seat is an open SKATER seat - not necessarily one this player can take. A defenceman counts a night whose only hole is at centre. Answering the finer question means per-slot capacity against per-player eligibility, and with three C seats, six of another and a flex F seat that is a seat-assignment problem rather than a lookup - a separate item with its own measurement, not a rename of this one. The field says what it measures. NOT "STARTED", EITHER. Nobody has set Thursday's lineup, so an open seat is CAPACITY minus the players whose club plays that night - the only forward-looking reading available, and the only one a free-agent finder can act on.
export function openSeatNights(candidate, proTeams, coverage, opts = {}) {
    // Only a free agent, because the question is "what would adding them do" - asked of a player already on the roster it answers about a move nobody can make.
    if (!opts.isFreeAgent) return null;
    const answer = nightsFilledBy(candidate, proTeams, coverage);
    // No club the schedule knows, or no coverage to intersect with.
    if (!answer) return null;
    // fills is null when the coverage carried no slot capacity: with no capacity there is no way to know what a hole IS, and an empty list would say "fills nothing" where the honest answer is "nobody said how many seats there are" (nightsFilledBy's own rule, kept rather than flattened here - a zero and an unknown are different answers to a manager).
    if (!answer.fills) return null;
    return { nights: answer.fills, count: answer.fills.length };
}

// THE MATRIX: the same question asked of several matchups at once, which is the shape a manager planning ahead wants - "which night of which round am I empty". `matchups` is [{ matchup, periods }], the same shape densityAcrossMatchups takes, so a caller that has already sliced the schedule for one read does not slice it again for this one. Rounds a roster cannot be measured against are absent rather than present and empty, the same rule every other builder here keeps.
export function nightsAcrossMatchups(roster, proTeams, matchups, opts) {
    const out = [];
    (matchups || []).forEach(m => {
        if (!m || m.matchup == null) return;
        const cover = rosterNightCoverage(roster, proTeams, m.periods, opts);
        if (!cover) return;
        out.push({ matchup: Number(m.matchup), ...cover });
    });
    out.sort((a, b) => a.matchup - b.matchup);
    return out;
}

// ==== Two-start weeks ====

// EXTENDS the validated probables machinery rather than repeating it. countProjectedStarts already knows how to read starterStatusByProGame, decide which side of a game a pitcher is on and name the opponent; all this adds is the matchup's own day span and the question "how many". It takes a WINDOW, so a matchup whose days are not contiguous (a folded break week) would pull in days that belong to a neighbour. The result is therefore filtered back down to the exact day set, which costs nothing and cannot be wrong. A pitcher with no PROBABLE games in the stretch is absent, not zero: ESPN publishes probables only a few days out, so "no starts" and "not announced yet" are the same silence, and reporting the first would be inventing news out of the second.
export function twoStartPitchers(pitchers, gameIndex, periods, { fromPeriod } = {}) {
    const days = (periods || []).map(Number).filter(Number.isFinite);
    if (!days.length) return { byPlayer: new Map(), twoPlus: [], total: 0 };
    const window = { start: Math.min(...days), end: Math.max(...days) };
    const wanted = new Set(days);
    const raw = countProjectedStarts(pitchers, gameIndex, window, fromPeriod ?? window.start);

    const byPlayer = new Map();
    let total = 0;
    raw.byPlayer.forEach((entry, id) => {
        const games = (entry.games || []).filter(g => wanted.has(Number(g.period)));
        if (!games.length) return;
        byPlayer.set(id, {
            starts: games.length,
            remaining: games.filter(g => !g.played).length,
            games
        });
        total += games.length;
    });
    // ORDERED ON PURPOSE. This came back from the pool in whatever order the pool happened to be in, which is an order nothing promises and a contract cannot describe - caught by diffing the fixture against this function's own output, where the two agreed on all 36 pitchers and disagreed on every position. Most starts first, then whoever goes first, then by id so ties never shuffle between runs.
    const twoPlus = [...byPlayer.entries()]
        .filter(([, v]) => v.starts >= 2)
        .sort((a, b) => (b[1].starts - a[1].starts)
            || (a[1].games[0].period - b[1].games[0].period)
            || (a[0] - b[0]))
        .map(([id]) => id);
    return { byPlayer, twoPlus, total };
}

// ==== Which matchups are the playoffs ====

// READ OFF THE LEAGUE'S OWN SCHEDULE, never computed from matchupPeriodCount. ESPN marks each playoff game with a playoffTierType, and that is a fact; arithmetic on the counts is an inference, and the counts do not mean what they look like - MEASURED, the hockey league's matchupPeriodCount is 21 while its schedule runs to matchup 24, because that field is the REGULAR season's length. AN EMPTY RESULT IS A REAL ANSWER. The owner's live baseball league marks no playoff matchup at all, because mid-season ESPN has not drawn the bracket yet. "Not scheduled yet" is what the surface should then say - guessing the rounds from playoffMatchupPeriodLength would put a confident number on a bracket that does not exist. Consolation rounds are excluded by default. A consolation ladder is played by teams already eliminated, so counting it as "the playoffs" would answer a different question than the one a manager planning a title run is asking.
export function playoffMatchups(schedule, { includeConsolation = false } = {}) {
    const found = new Set();
    (schedule || []).forEach(game => {
        const tier = game && game.playoffTierType;
        if (!tier || tier === 'NONE') return;
        if (!includeConsolation && String(tier).includes('CONSOLATION')) return;
        if (game.matchupPeriodId != null) found.add(Number(game.matchupPeriodId));
    });
    return [...found].sort((a, b) => a - b);
}
