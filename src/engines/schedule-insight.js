/**
 * What the pro schedule says about a matchup: how many games each club plays, which nights are
 * quiet, how many of a roster's players are on each night and what a free agent would add, a
 * football player's next game, pitchers with two starts, and which matchups are the playoffs.
 *
 * Pure, and it makes no request. Every function reads the pro-team schedule and the league payload
 * the app has already fetched. The days of a matchup are passed in by the caller, from the league's
 * own schedule; the schedule settings' list of matchup periods counts weeks and not days, and is
 * never used for it.
 *
 * Contract: tests/fixtures/schedule-insight.md
 * Tests: tests/features.test.html
 * @module schedule-insight
 */
/**
 * One club's games inside a stretch of scoring periods.
 *
 * @typedef {object} ClubGames
 * @property {number} games How many games the club plays in the stretch.
 * @property {Map<number, number>} byPeriod The count per period, for the periods with a game.
 * @property {Map<number, number>} officialByPeriod How many of those games ESPN has marked final, per period.
 * @property {Map<number, number[]>} ownDatesByPeriod The club's own game times, only for a period whose games span more than a day.
 */
/**
 * How many of a roster's players are on, night by night.
 *
 * @typedef {object} NightCoverage
 * @property {Array<{period: number, playing: number, idle: number, emptySlots: ?number, playerIds: Array}>} byPeriod One row per day. emptySlots is null when no slot count was given.
 * @property {number} players The players whose club the schedule knows.
 * @property {number} unknownClub The players whose club it does not know, counted apart and never as idle.
 * @property {number} fewestPlaying The fewest playing on any one night.
 * @property {number} mostPlaying The most playing on any one night.
 */
import { countProjectedStarts } from './probables.js';


// ==== How many games a club plays inside a stretch of days ====

/**
 * Every club's game count inside a set of scoring periods. A club with no game in the stretch is
 * still in the result, with a count of zero.
 *
 * @param {object[]} proTeams The pro teams from ESPN's schedule response, each with its games by scoring period.
 * @param {number[]} periods The scoring period ids of the stretch.
 * @returns {Map<number, ClubGames>} The games by pro team id.
 */
export function gamesByProTeamForMatchup(proTeams, periods) {
    const wanted = new Set((periods || []).map(Number).filter(Number.isFinite));
    const out = new Map();
    // A period longer than a day names its games by their own dates. A scoring period's label is one date for the whole period, which is right where the period is a day and wrong where it is a week. So a club's own game dates are kept, but only for a period whose games span more than a day across the league. The span is measured and never assumed per sport.
    const DAY_MS = 24 * 3600 * 1000;
    const span = new Map();
    (proTeams || []).forEach(team => {
        Object.entries((team && team.proGamesByScoringPeriod) || {}).forEach(([period, list]) => {
            const p = Number(period);
            if (!wanted.has(p)) return;
            (list || []).forEach(g => {
                const at = Number(g && g.date);
                if (!Number.isFinite(at)) return;
                const s = span.get(p) || { min: at, max: at };
                span.set(p, { min: Math.min(s.min, at), max: Math.max(s.max, at) });
            });
        });
    });
    const multiDay = new Set([...span.entries()].filter(([, s]) => s.max - s.min > DAY_MS).map(([p]) => p));
    (proTeams || []).forEach(team => {
        if (!team || team.id == null) return;
        // ESPN's free-agent pseudo-club has an id and no schedule. It is not a club.
        if (Number(team.id) === 0) return;
        const byPeriod = new Map();
        // How many of those games ESPN has marked final, per period. A count, since the only reader asks how many are behind us.
        const officialByPeriod = new Map();
        const ownDatesByPeriod = new Map();
        let games = 0;
        const sched = team.proGamesByScoringPeriod || {};
        Object.keys(sched).forEach(period => {
            const p = Number(period);
            if (!wanted.has(p)) return;
            const list = sched[period] || [];
            const n = list.length;
            if (!n) return;
            byPeriod.set(p, n);
            const official = list.filter(g => g && g.statsOfficial === true).length;
            if (official) officialByPeriod.set(p, official);
            if (multiDay.has(p)) {
                const dates = list.map(g => Number(g && g.date)).filter(Number.isFinite).sort((a, b) => a - b);
                if (dates.length) ownDatesByPeriod.set(p, dates);
            }
            games += n;
        });
        out.set(Number(team.id), { games, byPeriod, officialByPeriod, ownDatesByPeriod });
    });
    return out;
}

// A points matchup by game day. Who counts is ESPN's own list: the roster on a schedule side carries only the starters who have scored. When comes from the club: a player's points go on the day the player's club plays inside the matchup. A club with no game there, or more than one, is not guessed at, and those points are reported as unplaced. The day is the viewer's own calendar day.
function localDayKey(ms) {
    const d = new Date(Number(ms));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const roundPoints = (v) => Math.round(Number(v) * 100) / 100;

function clubGamesIn(gameIndex, periods) {
    const want = new Set((periods || []).map(Number).filter(Number.isFinite));
    const byClub = new Map();
    const games = gameIndex && typeof gameIndex.values === 'function'
        ? [...gameIndex.values()]
        : Object.values(gameIndex || {});
    games.forEach(g => {
        if (!g || !want.has(Number(g.period))) return;
        [g.home, g.away].forEach(club => {
            if (club === null || club === undefined) return;
            const key = Number(club);
            if (!byClub.has(key)) byClub.set(key, []);
            byClub.get(key).push(g);
        });
    });
    return byClub;
}

/**
 * One side of a points matchup split by the day its players' games fall on, for a sport whose
 * scoring period is a whole week.
 *
 * @param {object} side One side of a schedule entry, with its roster for the matchup.
 * @param {Map|object} gameIndex Pro games by id, each with its period, date and two clubs.
 * @param {number[]} periods The matchup's scoring periods.
 * @param {object} [options]
 * @param {function(number): string} [options.dayOf] Names the day a time falls on. Defaults to the local calendar date.
 * @returns {{byDay: Array<{day: string, at: number, points: number}>, total: number, unplaced: number, reconciles: ?boolean}}
 *   The days in order of first kickoff, the side's total, the points that could not be placed on
 *   a day, and whether the total equals ESPN's own live total.
 */
export function gameDayPoints(side, gameIndex, periods, { dayOf = localDayKey } = {}) {
    const entries = (side && side.rosterForMatchupPeriod && side.rosterForMatchupPeriod.entries) || [];
    const byClub = clubGamesIn(gameIndex, periods);
    const days = new Map();
    let total = 0;
    let unplaced = 0;
    entries.forEach(e => {
        const player = e && e.playerPoolEntry && e.playerPoolEntry.player;
        if (!player) return;
        const line = (player.stats || []).find(st => st && st.statSourceId === 0);
        const raw = line ? line.appliedTotal : e.playerPoolEntry.appliedStatTotal;
        const points = Number(raw);
        if (!Number.isFinite(points)) return;
        total += points;
        const games = byClub.get(Number(player.proTeamId)) || [];
        const at = games.length === 1 ? Number(games[0].date) : NaN;
        if (!Number.isFinite(at)) { unplaced += points; return; }
        const day = dayOf(at);
        const bucket = days.get(day) || { day, at, points: 0 };
        bucket.points += points;
        bucket.at = Math.min(bucket.at, at);
        days.set(day, bucket);
    });
    const live = Number(side && side.totalPointsLive);
    return {
        byDay: [...days.values()].sort((a, b) => a.at - b.at).map(b => ({ ...b, points: roundPoints(b.points) })),
        total: roundPoints(total),
        unplaced: roundPoints(unplaced),
        // Null when the side carries no live total to check against.
        reconciles: Number.isFinite(live) ? Math.abs(total - live) < 0.005 : null
    };
}

/**
 * Both sides of one matchup on a shared axis: every day either side scored on, in kickoff order,
 * with each side's running total. The two lines always have the same length.
 *
 * @param {object} home The home side of a schedule entry.
 * @param {object} away The away side.
 * @param {Map|object} gameIndex Pro games by id.
 * @param {number[]} periods The matchup's scoring periods.
 * @param {object} [options] Passed to gameDayPoints.
 * @returns {{days: Array<{day: string, at: number}>, home: number[], away: number[], homeTotal: number, awayTotal: number, unplaced: {home: number, away: number}, reconciles: {home: ?boolean, away: ?boolean}}}
 *   The axis and both running totals.
 */
export function gameDayRace(home, away, gameIndex, periods, options = {}) {
    const h = gameDayPoints(home, gameIndex, periods, options);
    const a = gameDayPoints(away, gameIndex, periods, options);
    const axis = new Map();
    [...h.byDay, ...a.byDay].forEach(d => {
        const seen = axis.get(d.day);
        axis.set(d.day, { day: d.day, at: seen ? Math.min(seen.at, d.at) : d.at });
    });
    const days = [...axis.values()].sort((x, y) => x.at - y.at);
    const running = (byDay) => {
        const on = new Map(byDay.map(d => [d.day, d.points]));
        let run = 0;
        return days.map(d => { run += on.get(d.day) || 0; return roundPoints(run); });
    };
    return {
        days,
        home: running(h.byDay),
        away: running(a.byDay),
        homeTotal: h.total,
        awayTotal: a.total,
        unplaced: { home: h.unplaced, away: a.unplaced },
        reconciles: { home: h.reconciles, away: a.reconciles }
    };
}

/**
 * The label for a football game's day: the local weekday, with 'Sun night' for a Sunday kickoff
 * at 18:00 or later.
 *
 * @param {number} ms The kickoff, in epoch milliseconds.
 * @returns {?string} The label, or null for no time.
 */
export function footballDayLabel(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return null;
    const d = new Date(Number(ms));
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    return weekday === 'Sun' && d.getHours() >= 18 ? 'Sun night' : weekday;
}

/**
 * A football player's game inside a matchup window: the day and the opponent. Where the window
 * holds two games it is the earliest not yet played, or the last one when all are behind.
 *
 * A club with no game in the window is on a bye, read from the absence and not from a bye-week
 * field. A kickoff ESPN has not set has no day. A game counts as played once ESPN marks it final,
 * or once its set start time has passed when the caller gives the present time.
 *
 * @param {{proTeamId: number}} player The player.
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {number[]|{periods: number[]}} window The matchup's scoring periods.
 * @param {object} [options]
 * @param {number} [options.now] The present, in epoch milliseconds.
 * @param {function(number): string} [options.dayLabelOf] Formats a kickoff's day. Defaults to footballDayLabel.
 * @returns {?{date: ?number, dayLabel: ?string, opponentAbbrev: ?string, home: ?boolean, tbd: boolean, bye: boolean, played: boolean, gameId: *}}
 *   Null when there is nothing true to say: no window, a player with no club, a club the schedule
 *   does not list, or a window in which no club has a game.
 */
export function nextGameOf(player, proTeams, window, { now = null, dayLabelOf = footballDayLabel } = {}) {
    const clubId = Number(player && player.proTeamId);
    if (!Number.isFinite(clubId) || clubId === 0) return null;
    const periods = new Set((Array.isArray(window) ? window : (window && window.periods) || [])
        .map(Number).filter(Number.isFinite));
    if (!periods.size) return null;
    const teams = (proTeams || []).filter(t => t && t.id != null);
    const club = teams.find(t => Number(t.id) === clubId);
    if (!club) return null;
    const gamesIn = (team) => Object.entries(team.proGamesByScoringPeriod || {})
        .filter(([period]) => periods.has(Number(period)))
        .flatMap(([, list]) => (list || []).filter(Boolean));
    if (!teams.some(t => gamesIn(t).length)) return null;

    const games = gamesIn(club).sort((a, b) => Number(a.date) - Number(b.date));
    if (!games.length) {
        return { date: null, dayLabel: null, opponentAbbrev: null, home: null, tbd: false, bye: true, played: false, gameId: null };
    }
    const hasNow = now !== null && now !== undefined && Number.isFinite(Number(now));
    const isPlayed = (g) => g.statsOfficial === true
        || (hasNow && g.startTimeTBD !== true && Number.isFinite(Number(g.date)) && Number(g.date) <= Number(now));
    const game = games.find(g => !isPlayed(g)) || games[games.length - 1];
    const home = Number(game.homeProTeamId) === clubId;
    const opponentId = Number(home ? game.awayProTeamId : game.homeProTeamId);
    const opponent = teams.find(t => Number(t.id) === opponentId);
    const tbd = game.startTimeTBD === true;
    const date = !tbd && Number.isFinite(Number(game.date)) ? Number(game.date) : null;
    return {
        date,
        dayLabel: date === null ? null : dayLabelOf(date),
        opponentAbbrev: opponent && opponent.abbrev ? String(opponent.abbrev).trim() : null,
        home,
        tbd,
        bye: false,
        played: isPlayed(game),
        gameId: game.id != null ? game.id : null
    };
}

/**
 * Every club's game count for several matchups at once.
 *
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {Array<{matchup: number, periods: number[]}>} matchups The matchups and their scoring periods.
 * @returns {Array<{matchup: number, periods: number, byTeam: Map<number, ClubGames>}>} One row per matchup, in order, with its length in days.
 */
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

/**
 * One player's playoff window: the club's games in each round, with each round's length in days,
 * since rounds differ in length.
 *
 * @param {Array<{matchup: number, periods: number, byTeam: (Map|object)}>} rows The rounds, from densityAcrossMatchups.
 * @param {number} proTeamId The player's club.
 * @param {object} [options]
 * @param {?number} [options.perGame] The player's own projection per game.
 * @param {*} [options.trend] Passed through.
 * @returns {?{games: number, byRound: Array<{matchup: number, games: number, days: number}>, projected: ?number, trend: *}}
 *   Null for a club the schedule does not know. The projection is null without a per-game figure.
 */
export function playoffOutlook(rows, proTeamId, { perGame = null, trend = null } = {}) {
    if (!rows || !rows.length) return null;
    const id = Number(proTeamId);
    if (!Number.isFinite(id)) return null;
    // A Map when live and a plain object from a fixture. The rows are the same either way.
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
    // Number(null) is 0, so the null check comes before the conversion. A player without a projection must not read as a projection of zero.
    const pg = (perGame === null || perGame === undefined) ? null : Number(perGame);
    return {
        games,
        byRound,
        projected: (pg !== null && Number.isFinite(pg)) ? pg * games : null,
        trend: trend || null
    };
}

/**
 * One club's games in one matchup: how many, how many are played, and how many remain. A game on
 * the present day counts as remaining.
 *
 * @param {Map<number, ClubGames>|object} byTeam The games by club, from gamesByProTeamForMatchup.
 * @param {number} proTeamId The club.
 * @param {object} [options]
 * @param {?number} [options.matchup] The matchup's number, passed through.
 * @param {?number[]} [options.periods] Every day the window covers.
 * @param {function(number): string} [options.labelOf] Labels a period.
 * @param {function(number): string} [options.labelOfDate] Labels a game's own time, for a period longer than a day.
 * @param {?number} [options.fromPeriod] The present scoring period.
 * @param {?{total: number, remaining: number}} [options.starts] A pitcher's starts in the window, passed in and never computed here.
 * @param {?{byPeriod: object[], clubCount: number}} [options.density] The league-wide counts from offNightsForMatchup.
 * @param {number} [options.offNightShare] The share of clubs below which a night is quiet. Defaults to a third.
 * @param {boolean} [options.countStarts=false] Count the pitcher's starts in place of the club's games.
 * @returns {?{matchup: ?number, games: number, played: number, remaining: number, unit: ('games'|'starts'), offNight: ?number, twoGameDays: ?number, byPeriod: Array<{period: string, count: number}>, starts: ?object}}
 *   Null for a club the schedule does not carry. A club it carries that is not playing reads zero
 *   games.
 */
export function matchupWindow(byTeam, proTeamId, { matchup = null, periods = null, labelOf = null, labelOfDate = null, fromPeriod = null, starts = null, density = null, offNightShare = 1 / 3, countStarts = false } = {}) {
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

    // Every day the window covers, not only the days this club plays, so an idle day is a real entry with a count of 0. Falls back to the days the club plays when the caller does not say what the window spans.
    const days = (periods && periods.length)
        ? [...periods].map(Number).filter(Number.isFinite)
        : [...countByPeriod.keys()].sort((a, b) => a - b);

    // The label is formatted here, from a function the caller passes in. A period longer than a day is labelled by this club's own game date, and two games in one such period name both days once each.
    const ownDates = entry.ownDatesByPeriod && typeof entry.ownDatesByPeriod.get === 'function'
        ? entry.ownDatesByPeriod : null;
    const byPeriod = days.map(p => {
        const own = labelOfDate && ownDates ? ownDates.get(p) : null;
        const label = own && own.length
            ? [...new Set(own.map(labelOfDate))].join('/')
            : (labelOf ? labelOf(p) : String(p));
        return { period: label, count: countByPeriod.get(p) || 0 };
    });

    const games = Number.isFinite(Number(entry.games)) ? Number(entry.games) : [...countByPeriod.values()].reduce((s, c) => s + c, 0);
    // Number(null) is 0, and a missing present day must not read as day zero, or every game in the window would count as played.
    const from = (fromPeriod === null || fromPeriod === undefined) ? null : Number(fromPeriod);
    const hasFrom = from !== null && Number.isFinite(from);

    // A game ESPN has marked final is played, whatever period it sits in, since in football a period is the whole week. The mark only ever adds a played game and never replaces the period test: baseball does not keep the mark on past games. Before today is played; on or after today, only what ESPN has marked final.
    const official = entry.officialByPeriod
        ? (typeof entry.officialByPeriod.get === 'function'
            ? entry.officialByPeriod
            : new Map(Object.entries(entry.officialByPeriod).map(([k, v]) => [Number(k), v])))
        : null;
    const played = [...countByPeriod.entries()].reduce((sum, [p, c]) => {
        if (hasFrom && p < from) return sum + c;
        const done = official ? Number(official.get(p)) || 0 : 0;
        return sum + Math.min(done, c);
    }, 0);

    // Two counts about when the games fall. The off-night count is of games on nights when fewer than a share of the clubs play; the share arrives as an argument because the club count differs by sport. Null when the league-wide density was not supplied, since a zero would claim that no game falls on a quiet night.
    const dayCounts = density && density.byPeriod
        ? new Map(density.byPeriod.map(d => [Number(d.period), Number(d.teamsPlaying) || 0]))
        : null;
    const clubCount = density && Number(density.clubCount) > 0 ? Number(density.clubCount) : 0;
    const offNight = (dayCounts && clubCount)
        ? [...countByPeriod.entries()]
            .filter(([p]) => dayCounts.has(p) && dayCounts.get(p) < clubCount * offNightShare)
            .reduce((sum, [, c]) => sum + c, 0)
        : null;

    // Days with two or more games, counted as days and not games. It needs no league-wide table.
    const twoGameDays = [...countByPeriod.values()].filter(c => c >= 2).length;

    // Counted in starts, when the caller has established that this player is a starting pitcher and that ESPN has listed the whole window. The two counts beside it go null, since both count the club's games and say nothing of one pitcher's turn.
    const counted = !!(countStarts && starts);
    const total = counted ? (Number(starts.total) || 0) : games;
    const before = counted ? total - (Number(starts.remaining) || 0) : played;

    return {
        matchup: matchup === null || matchup === undefined ? null : Number(matchup),
        games: total,
        played: before,
        // Remaining is derived from the other two, so the three always add up.
        remaining: total - before,
        // What the three counts above are counting.
        unit: counted ? 'starts' : 'games',
        offNight: counted ? null : offNight,
        twoGameDays: counted ? null : twoGameDays,
        byPeriod,
        starts: starts || null
    };
}

/**
 * One club's game count across several matchups.
 *
 * @param {Array<{matchup: number, byTeam: Map}>} rows The rows from densityAcrossMatchups.
 * @param {number} proTeamId The club.
 * @returns {Array<{matchup: number, games: number}>} One row per matchup.
 */
export function teamDensity(rows, proTeamId) {
    const id = Number(proTeamId);
    return (rows || []).map(r => ({
        matchup: r.matchup,
        games: (r.byTeam.get(id) || { games: 0 }).games
    }));
}

// ==== Off nights ====

/**
 * How many clubs play on each day of a stretch, as counts and not percentages.
 *
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {number[]} periods The scoring periods of the stretch.
 * @returns {{byPeriod: Array<{period: number, teamsPlaying: number, clubs: number[]}>, clubCount: number, lightest: number, heaviest: number}}
 *   One row per day with the clubs playing, the count of clubs, and the fewest and most on a day.
 */
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

/**
 * How many of a roster's players play on each night of a stretch. A player whose club the
 * schedule does not know is counted apart and never as idle.
 *
 * @param {Array<{id: *, proTeamId: number}>} roster The players to ask about.
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {number[]} periods The scoring periods of the stretch.
 * @param {object} [options]
 * @param {?number} [options.slots] How many lineup slots those players compete for.
 * @returns {?NightCoverage} The coverage, or null for no days.
 */
export function rosterNightCoverage(roster, proTeams, periods, { slots = null } = {}) {
    const days = (periods || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!days.length) return null;

    // One pass over the clubs, not one per night.
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
            // Idle is measured against the players whose club the schedule knows.
            idle: known.length - playing.length,
            // What the lineup cannot fill. Null when the caller gave no slot count, since an unstated capacity is unknown and not zero. Never below zero: more players than slots is a choice to make, not an emptiness.
            emptySlots: (slots === null || slots === undefined) ? null : Math.max(0, Number(slots) - playing.length),
            playerIds: playing.map(p => p.id)
        };
    });

    const counts = byPeriod.map(d => d.playing);
    // The fewest and the most playing over the window.
    return {
        byPeriod,
        players: known.length,
        unknownClub,
        fewestPlaying: Math.min(...counts),
        mostPlaying: Math.max(...counts)
    };
}

/**
 * Which nights a free agent would fill: the nights the player's club plays on which the lineup
 * has an empty slot.
 *
 * @param {{proTeamId: number}} candidate The free agent.
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {NightCoverage} coverage The roster's coverage.
 * @returns {?{plays: number[], fills: ?number[], fillCount: ?number}} Null for a club the schedule does not know. The fills are null when the coverage carries no slot count.
 */
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

/**
 * The nights a free agent's club plays on which the roster's group has an open seat. An open
 * seat is capacity less the players whose club plays that night; it is not checked against the
 * positions this player can fill.
 *
 * @param {{proTeamId: number}} candidate The player.
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {NightCoverage} coverage The roster's coverage.
 * @param {object} [opts]
 * @param {boolean} [opts.isFreeAgent] Only a free agent is answered.
 * @returns {?{nights: number[], count: number}} Null when the question cannot be answered.
 */
export function openSeatNights(candidate, proTeams, coverage, opts = {}) {
    // Only a free agent is answered, since the question is what adding the player would do.
    if (!opts.isFreeAgent) return null;
    const answer = nightsFilledBy(candidate, proTeams, coverage);
    // No club the schedule knows, or no coverage to intersect with.
    if (!answer) return null;
    // No slot capacity means no way to know what an open seat is. Null, since an empty list would claim the player fills nothing.
    if (!answer.fills) return null;
    return { nights: answer.fills, count: answer.fills.length };
}

/**
 * A roster's night coverage for several matchups at once. A matchup that cannot be measured is
 * left out.
 *
 * @param {Array<{id: *, proTeamId: number}>} roster The players.
 * @param {object[]} proTeams The pro teams from ESPN's schedule response.
 * @param {Array<{matchup: number, periods: number[]}>} matchups The matchups and their scoring periods.
 * @param {object} [opts] Passed to rosterNightCoverage.
 * @returns {Array<object>} One coverage per matchup, in order, each with its matchup number.
 */
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

/**
 * The pitchers ESPN lists as probable starters inside a matchup's days, and which of them start
 * twice or more. A pitcher with no probable start listed is absent, not zero: probables are
 * published only a few days out.
 *
 * @param {object[]} pitchers The pitchers to ask about.
 * @param {Map|object} gameIndex Pro games by id.
 * @param {number[]} periods The matchup's scoring periods.
 * @param {object} [options]
 * @param {number} [options.fromPeriod] The present scoring period.
 * @returns {{byPlayer: Map<*, {starts: number, remaining: number, games: object[]}>, twoPlus: Array, total: number}}
 *   The starts by player, the ids with two or more in a fixed order, and the total.
 */
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
    // Ordered on purpose: most starts first, then whoever starts first, then by id, so ties never move between runs.
    const twoPlus = [...byPlayer.entries()]
        .filter(([, v]) => v.starts >= 2)
        .sort((a, b) => (b[1].starts - a[1].starts)
            || (a[1].games[0].period - b[1].games[0].period)
            || (a[0] - b[0]))
        .map(([id]) => id);
    return { byPlayer, twoPlus, total };
}

// ==== Which matchups are the playoffs ====

/**
 * Which matchups are the playoffs, read off the league's own schedule by ESPN's tier mark on each
 * game. An empty result is a real answer: the bracket has not been drawn yet.
 *
 * @param {object[]} schedule The league's schedule.
 * @param {object} [options]
 * @param {boolean} [options.includeConsolation=false] Count the consolation rounds too.
 * @returns {number[]} The playoff matchup periods, ascending.
 */
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
