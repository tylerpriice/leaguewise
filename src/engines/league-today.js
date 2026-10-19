/**
 * Every league at once: one model per league for the reader's own team. The lineup today, each
 * player's game and whether it has started, today's line where there is one, a benched player
 * beside an open seat, and the recent window against the season. Also which leagues are worth
 * asking about.
 *
 * Pure. No DOM, no application state, no network and no clock; the present is an argument. Every
 * league is an argument too, so a page across several leagues never touches the one league the
 * rest of the app holds. No stat id and no slot id is written here: which slots are a bench, which
 * stat counts games and how long a game runs arrive in the rules.
 *
 * Contract: tests/fixtures/league-today.md
 * Tests: tests/league-today.test.html
 * @module league-today
 */
/**
 * What a sport's catalogs say, handed in per league.
 *
 * @typedef {object} LeagueTodayRules
 * @property {Set<number>|number[]} [benchSlots] The bench slot ids.
 * @property {Set<number>|number[]} [nonStartingSlots] The bench and injury slot ids.
 * @property {string|number} [gamesId] The stat id that counts a player's games.
 * @property {Array<string|number>} [categoryIds] The scored categories, for a league that scores categories.
 * @property {Set<string>|string[]} [rateIds] Which of those are rates.
 * @property {number} [gameLengthMs] How long a game is taken to run, in milliseconds.
 */
/**
 * One league's model for the reader's own team.
 *
 * @typedef {object} LeagueToday
 * @property {*} leagueId The league.
 * @property {?number} seasonId The season.
 * @property {?string} name The league's name.
 * @property {?('preseason'|'underway')} life Which life the league is living, or null for a league that is not active.
 * @property {?number} period The scoring period the model was built for.
 * @property {*} teamId The reader's team.
 * @property {?number} gameLengthMs The game length the states were judged over.
 * @property {?('side'|'rosterView')} lineupSource Where the lineup was read from.
 * @property {?object[]} players One row per rostered player, with its slot, its game and state, today's line and the trend.
 * @property {?Array<{slotId: number, count: number}>} openSeats The starting slots with a seat unfilled.
 * @property {Array<{playerId: *, fromSlotId: number, openSlotIds: number[], tooLate: boolean}>} alerts The benched players who fit an open seat and whose club plays.
 * @property {string[]} missing What the model could not be given, by name.
 */
import { seasonState, seasonIsFinished, draftTabShowsResults, SEASON_STATE } from '../data/season-state.js';

const asSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
// Null is not zero, and Number(null) is 0, so an absent figure stays absent.
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

// ==== Which leagues ====

// The one sub-type measured as a mock. A value not seen before passes.
const MOCK_SUBTYPE = 'MOCKDRAFT_LOBBY';

/**
 * Whether a league is worth fetching, from the account lookup's own marks, at no request. A mock
 * league is dropped first, then one not drafted, then one stated to be out of season. A missing
 * in-season mark does not drop a league.
 *
 * @param {?{subType: string, drafted: boolean, inSeason: boolean}} record The league's marks. Null for a league entered by hand, which is kept.
 * @returns {{keep: boolean, reason: ?('mock'|'undrafted'|'out-of-season')}} The answer and why.
 */
export function activeByLookup(record) {
    if (!record) return { keep: true, reason: null };     // entered by hand: the payload decides
    if (record.subType === MOCK_SUBTYPE) return { keep: false, reason: 'mock' };
    if (record.drafted !== true) return { keep: false, reason: 'undrafted' };
    if (record.inSeason === false) return { keep: false, reason: 'out-of-season' };
    return { keep: true, reason: null };
}

/**
 * Whether a league is active, once its payload is in hand. A league that has drafted and not
 * played is active. Because ESPN is slow to mark a finished draft, a roster view with somebody on
 * every team also counts as drafted.
 *
 * @param {?object} record The league's marks from the account lookup.
 * @param {object} payload The league payload.
 * @param {?{teams: object[]}} [rosterView] The league's roster view.
 * @returns {{active: boolean, life: ?('preseason'|'underway'), reason: ?string}} The life when active, and otherwise the reason.
 */
export function activeLeague(record, payload, rosterView = null) {
    const byLookup = activeByLookup(record);
    if (!byLookup.keep) return { active: false, life: null, reason: byLookup.reason };
    if (!payload) return { active: false, life: null, reason: 'no-payload' };
    const state = seasonState(payload);
    if (state === SEASON_STATE.PRE_DRAFT) {
        const drafted = draftTabShowsResults({ draftDetail: payload.draftDetail, teams: rosterView && rosterView.teams });
        if (!drafted) return { active: false, life: null, reason: 'undrafted' };
        return { active: true, life: 'preseason', reason: null };
    }
    if (seasonIsFinished(payload)) return { active: false, life: null, reason: 'finished' };
    return { active: true, life: state === SEASON_STATE.PRESEASON ? 'preseason' : 'underway', reason: null };
}

// ==== A game's state, off the clock ====

/**
 * A game's state at a moment. No payload marks a game live or final, so the state is the start
 * time against the present. A game is over on ESPN's official mark, or once the length the caller
 * names has passed; with no length a started game stays started until it is official.
 *
 * @param {{date: number, statsOfficial: (boolean|undefined)}} game The game, with its start time.
 * @param {number} now The present, in epoch milliseconds.
 * @param {?number} [lengthMs] How long a game is taken to run.
 * @returns {?('later'|'started'|'over')} The state, or null with no start time or no present.
 */
export function gameStateAt(game, now, lengthMs = null) {
    const start = num(game && game.date);
    if (start === null || num(now) === null) return null;
    if (now < start) return 'later';
    if (game.statsOfficial === true) return 'over';
    if (num(lengthMs) !== null && now >= start + lengthMs) return 'over';
    return 'started';
}

function clubIndex(proSchedule) {
    const teams = proSchedule && proSchedule.settings && proSchedule.settings.proTeams;
    if (!Array.isArray(teams)) return null;
    const out = new Map();
    teams.forEach(t => {
        // Club 0 is the free-agent pseudo-club. A player on it has no schedule, which is an unknown and not an idle night.
        if (!t || t.id === null || t.id === undefined || Number(t.id) === 0) return;
        out.set(Number(t.id), t.proGamesByScoringPeriod || {});
    });
    return out;
}

const NO_GAME = { state: 'none', startsAt: null, gameId: null, home: null, opponentProTeamId: null, count: 0 };

function gameFor(clubs, proTeamId, period, now, lengthMs) {
    if (!clubs) return null;
    const club = Number(proTeamId);
    if (!clubs.has(club)) return null;
    const games = (clubs.get(club)[String(period)] || []).filter(Boolean);
    if (!games.length) return { ...NO_GAME };
    const withState = games.map(g => ({ g, state: gameStateAt(g, now, lengthMs) }));
    // With two games in the period, the one taken is the first under way, else the earliest still to come, else the last one finished.
    const pick = withState.find(x => x.state === 'started')
        || withState.filter(x => x.state === 'later').sort((a, b) => a.g.date - b.g.date)[0]
        || withState[withState.length - 1];
    const home = Number(pick.g.homeProTeamId) === club;
    return {
        state: pick.state,
        startsAt: num(pick.g.date),
        gameId: pick.g.id ?? null,
        home,
        opponentProTeamId: num(home ? pick.g.awayProTeamId : pick.g.homeProTeamId),
        count: games.length
    };
}

// ==== The lineup ====

const playerOf = (entry) => (entry && entry.playerPoolEntry && entry.playerPoolEntry.player) || {};

// The payload's own side first: the current matchup's side for this team carries today's lineup with today's lines. A drafted league that has not played, and a roto league, carry none there, and the roster view's team answers.
function lineupOf(payload, rosterView, teamId) {
    const current = payload.status && payload.status.currentMatchupPeriod;
    const sides = (payload.schedule || [])
        .filter(m => m && m.matchupPeriodId === current)
        .flatMap(m => [m.home, m.away])
        .filter(s => s && String(s.teamId) === String(teamId));
    for (const side of sides) {
        const entries = side.rosterForCurrentScoringPeriod && side.rosterForCurrentScoringPeriod.entries;
        if (Array.isArray(entries) && entries.length) return { entries, source: 'side' };
    }
    const viewEntries = rosterViewEntries(rosterView, teamId);
    if (viewEntries && viewEntries.length) return { entries: viewEntries, source: 'rosterView' };
    return { entries: null, source: null };
}

function rosterViewEntries(rosterView, teamId) {
    const team = ((rosterView && rosterView.teams) || []).find(t => t && String(t.id) === String(teamId));
    const entries = team && team.roster && team.roster.entries;
    return Array.isArray(entries) ? entries : null;
}

// ==== The trend: the recent window's rate per game against the season's ====

// ESPN's own splits: 1, 2 and 3 are the last 7, 15 and 30 scoring periods. They are calendar windows, not the last so many games.
const WINDOW_SPLITS = [['7', 1], ['15', 2], ['30', 3]];

function trendFor(entry, seasonId, rules) {
    if (!entry || rules.gamesId === null || rules.gamesId === undefined) return null;
    const lines = (playerOf(entry).stats || []).filter(l => l && l.statSourceId === 0 && l.seasonId === seasonId);
    const bySplit = (split) => lines.find(l => l.statSplitTypeId === split && !l.scoringPeriodId) || null;
    const season = bySplit(0);
    if (!season) return null;
    const gamesOf = (line) => num((line.stats || {})[rules.gamesId]) || 0;
    // A rate over no games is null, never zero, since a zero would read as a slump.
    const per = (total, games) => (total === null || !(games > 0) ? null : total / games);

    if (num(season.appliedTotal) !== null) {
        const seasonGames = gamesOf(season);
        const seasonPer = per(num(season.appliedTotal), seasonGames);
        const windows = {};
        WINDOW_SPLITS.forEach(([key, split]) => {
            const line = bySplit(split);
            if (!line) { windows[key] = null; return; }
            const games = gamesOf(line);
            const total = num(line.appliedTotal);
            const perGame = per(total, games);
            windows[key] = { games, total, perGame, delta: (perGame === null || seasonPer === null) ? null : perGame - seasonPer };
        });
        return { basis: 'points', season: { games: seasonGames, perGame: seasonPer }, windows };
    }

    // Categories: the rates side by side and nothing summed. Which way is better, and how categories weigh against each other, belongs to the rank engine.
    const ids = Array.isArray(rules.categoryIds) ? rules.categoryIds : [];
    if (!ids.length) return null;
    const rateIds = asSet(rules.rateIds);
    const valueOf = (line, id, games) => {
        const v = num((line.stats || {})[id]);
        if (v === null) return null;
        return rateIds.has(id) ? v : per(v, games);
    };
    const seasonGames = gamesOf(season);
    const windows = {};
    WINDOW_SPLITS.forEach(([key, split]) => {
        const line = bySplit(split);
        if (!line) { windows[key] = null; return; }
        const games = gamesOf(line);
        windows[key] = {
            games,
            categories: ids.map(id => ({ id, recent: valueOf(line, id, games), season: valueOf(season, id, seasonGames) }))
        };
    });
    return { basis: 'categories', season: { games: seasonGames }, windows };
}

// ==== One league ====

/**
 * Builds one league's model for the reader's team. A figure that could not be supplied is named
 * in the model's missing list and is never a zero.
 *
 * @param {object} [args]
 * @param {object} args.payload The league payload.
 * @param {?object} [args.rosterView] The league's roster view, for the lineup of a league that has not played and for the trend.
 * @param {?object} [args.proSchedule] ESPN's pro schedule response.
 * @param {number|string} args.teamId The reader's team.
 * @param {number} args.now The present, in epoch milliseconds.
 * @param {LeagueTodayRules} [args.rules] The sport's catalogs.
 * @param {?object} [args.record] The league's marks from the account lookup.
 * @returns {LeagueToday} The model. An inactive league has no players and 'inactive' in its missing list.
 */
export function leagueToday({ payload, rosterView = null, proSchedule = null, teamId, now, rules = {}, record = null } = {}) {
    const settings = (payload && payload.settings) || {};
    const team = ((payload && payload.teams) || []).find(t => t && String(t.id) === String(teamId)) || null;
    const verdict = activeLeague(record, payload, rosterView);
    const head = {
        leagueId: payload ? payload.id ?? null : null,
        gameId: payload ? payload.gameId ?? null : null,
        seasonId: payload ? payload.seasonId ?? null : null,
        name: settings.name ?? null,
        scoringType: (settings.scoringSettings && settings.scoringSettings.scoringType) ?? null,
        life: verdict.life,
        period: payload ? num(payload.scoringPeriodId ?? (payload.status && payload.status.latestScoringPeriod)) : null,
        teamId: teamId ?? null,
        teamName: team ? team.name ?? null : null,
        // The length this league's games were judged over, carried so a model read later needs only itself and the clock.
        gameLengthMs: num(rules.gameLengthMs)
    };
    if (!verdict.active) {
        return { ...head, lineupSource: null, players: null, openSeats: null, alerts: [], missing: ['inactive'] };
    }

    const missing = [];
    const benchSlots = asSet(rules.benchSlots);
    const nonStarting = asSet(rules.nonStartingSlots);
    const preseason = verdict.life === 'preseason';
    const clubs = clubIndex(proSchedule);
    const { entries, source } = lineupOf(payload, rosterView, teamId);
    if (!entries) missing.push('lineup');
    if (!clubs) missing.push('schedule');

    const viewEntries = rosterViewEntries(rosterView, teamId);
    const viewById = new Map((viewEntries || []).map(e => [String(e.playerId), e]));

    const players = entries ? entries.map(entry => {
        const pl = playerOf(entry);
        const slotId = num(entry.lineupSlotId);
        const lines = (pl.stats || []).filter(l => l && num(l.scoringPeriodId) === head.period && head.period !== null);
        const actual = lines.find(l => l.statSourceId === 0) || null;
        const projection = lines.find(l => l.statSourceId === 1) || null;
        return {
            playerId: entry.playerId ?? pl.id ?? null,
            name: pl.fullName ?? null,
            slotId,
            starting: !nonStarting.has(slotId),
            bench: benchSlots.has(slotId),
            proTeamId: num(pl.proTeamId),
            eligibleSlots: Array.isArray(pl.eligibleSlots) ? pl.eligibleSlots.slice() : [],
            injuryStatus: pl.injuryStatus ?? null,
            game: gameFor(clubs, pl.proTeamId, head.period, now, rules.gameLengthMs ?? null),
            // A league that has not played shows the lineup and no figures.
            line: (preseason || !actual) ? null
                : { points: num(actual.appliedTotal), stats: { ...(actual.stats || {}) }, empty: Object.keys(actual.stats || {}).length === 0 },
            projected: (preseason || !projection) ? null : num(projection.appliedTotal),
            trend: preseason ? null : trendFor(viewById.get(String(entry.playerId)), head.seasonId, rules)
        };
    }) : null;

    if (!preseason) {
        if (!viewEntries) missing.push('rosterView');
        else if (rules.gamesId === null || rules.gamesId === undefined) missing.push('gamesId');
    }

    // Open seats: each starting slot's count less the rows seated in it. It says a fitting seat exists and seats nobody.
    const counts = settings.rosterSettings && settings.rosterSettings.lineupSlotCounts;
    let openSeats = null;
    if (!counts || typeof counts !== 'object') missing.push('slotCounts');
    else if (players) {
        openSeats = Object.keys(counts)
            .map(k => ({ slotId: Number(k), count: (Number(counts[k]) || 0) - players.filter(p => p.slotId === Number(k)).length }))
            .filter(s => Number.isFinite(s.slotId) && !nonStarting.has(s.slotId) && s.count > 0)
            .sort((a, b) => a.slotId - b.slotId);
    }

    // The alert is for open seats only: a benched player whose club plays this period and who fits a seat standing open. An injured player's seat and a swap for an idle starter are not alerts.
    const alerts = [];
    if (players && openSeats && clubs) {
        const open = new Set(openSeats.map(s => s.slotId));
        players.forEach(p => {
            if (!p.bench || !p.game || p.game.state === 'none') return;
            const openSlotIds = p.eligibleSlots.map(Number).filter(id => open.has(id)).sort((a, b) => a - b);
            if (!openSlotIds.length) return;
            // Too late means the game has started. ESPN's own lock is not in the payload; the start time is.
            alerts.push({ playerId: p.playerId, fromSlotId: p.slotId, openSlotIds, tooLate: p.game.state !== 'later' });
        });
    }

    return { ...head, lineupSource: source, players, openSeats, alerts, missing };
}

// ==== Every league ====

function totalsOf(leagues) {
    const active = leagues.filter(l => l && l.life !== null);
    const rows = active.flatMap(l => l.players || []);
    return {
        leagues: active.length,
        players: rows.length,
        started: rows.filter(p => p.game && p.game.state === 'started').length,
        alerts: active.reduce((sum, l) => sum + (l.alerts || []).filter(a => !a.tooLate).length, 0)
    };
}

/**
 * Builds the model for several leagues at one moment, with totals across the active ones.
 *
 * @param {object[]} inputs One set of leagueToday's arguments per league, without the present.
 * @param {object} [options]
 * @param {number} [options.now] The present, in epoch milliseconds.
 * @returns {{leagues: LeagueToday[], totals: {leagues: number, players: number, started: number, alerts: number}}} The models and the totals.
 */
export function leaguesToday(inputs, { now } = {}) {
    const leagues = (Array.isArray(inputs) ? inputs : []).map(input => leagueToday({ ...input, now }));
    return { leagues, totals: totalsOf(leagues) };
}

// ==== A model, read later ====

/**
 * A built model at a later moment. The figures stay as fetched; each game's state is asked again
 * of the clock, and the alerts and the totals follow. Nothing is fetched and the model passed in
 * is not changed.
 *
 * A game already over stays over, and a club with two games in the period keeps the game it had.
 *
 * @param {{leagues: LeagueToday[]}} model A model from leaguesToday.
 * @param {number} now The present, in epoch milliseconds.
 * @returns {{leagues: LeagueToday[], totals: object}} The model at that moment.
 */
export function leaguesTodayAt(model, now) {
    const leagues = ((model && model.leagues) || []).map(league => {
        if (!league || !Array.isArray(league.players)) return league;
        const lengthMs = num(league.gameLengthMs);
        const players = league.players.map(p => {
            if (!p.game || p.game.startsAt === null || p.game.startsAt === undefined || p.game.state === 'over') return p;
            const state = gameStateAt({ date: p.game.startsAt }, now, lengthMs);
            return state && state !== p.game.state ? { ...p, game: { ...p.game, state } } : p;
        });
        const stateOf = new Map(players.map(p => [String(p.playerId), p.game && p.game.state]));
        const alerts = (league.alerts || []).map(a => ({ ...a, tooLate: stateOf.get(String(a.playerId)) !== 'later' }));
        return { ...league, players, alerts };
    });
    return { leagues, totals: totalsOf(leagues) };
}
