/**
 * The matchup chance as a finished model: the one caller of matchup-sides.js, matchup-odds.js and
 * odds-record.js. It assembles what they need from what the app already holds, so a face renders
 * the answer and computes nothing.
 *
 * Everything it reads is an argument: the league payload, the pool, the pro schedule, the
 * harvest's day lines, the matchup map and the storage verbs. It reads no application state, and
 * storage only through the verbs it is handed. Nothing here is fetched.
 *
 * It imports nothing from a view. The matchup map and the two readers of a schedule side belong
 * to one and are handed in.
 *
 * Contract: tests/fixtures/matchup-face.md
 * Tests: tests/matchup-face.test.html
 * @module matchup-face
 */
/**
 * What the model is handed.
 *
 * @typedef {object} FaceInputs
 * @property {object} payload The league payload, as fetched.
 * @property {number|string} teamId The reader's own team.
 * @property {string} sport The sport key.
 * @property {Array<{id: number, player: object}>|{players: Array}} pool The pool's entries.
 * @property {object} proSchedule The pro schedule response.
 * @property {function((number|string)): ?Object<string, Object<string, number>>} [dayLinesOf] One player's day lines by scoring period, this season's. In a points league each line is its points, as { points }.
 * @property {object} matchupMap The matchup map the caller built, which carries the open matchup's own span.
 * @property {{tallyOf: function(object): ?object, pointsOf: function(object): number}} read The caller's readers of a schedule side: its live tally and its live points.
 * @property {?string} [asOf] When the caller says this is being shown; passed through to the record.
 */
import { matchupSides, poolVariance } from '../engines/matchup-sides.js';
import { matchupOdds } from '../engines/matchup-odds.js';
import { buildGamePeriodIndex, countProjectedStarts, currentMatchupWindow } from '../engines/probables.js';
import { recordPrediction, scorePredictions, chanceWord, recordEarnsNumber } from './odds-record.js';
import { leagueInverseIds, NON_STARTING_SLOTS, RATE_COMPONENTS, PITCHING_IDS } from './state.js';

const key = id => String(id);

// ==== The seats of a sport ====

// Which seats a position competes for, which id of a stats row is its games, which slots are a group's own seats and which take none. The constants are the ones the validation ran on.
const SEAT_TABLES = {
    flb: {
        groupOfPosition: position => (position === 1 || position === 11 ? 'pitcher' : 'hitter'),
        gamesIdOf: group => (group === 'pitcher' ? '32' : '81'),
        groupOfSlot: slot => (['13', '14', '15'].includes(key(slot)) ? 'pitcher' : 'hitter'),
        outSlots: [17],
        groupNames: { hitter: 'hitters', pitcher: 'pitchers' },
        splitsStats: true
    },
    fhl: {
        groupOfPosition: position => (position === 5 ? 'goalie' : 'skater'),
        gamesIdOf: () => '30',
        groupOfSlot: slot => (key(slot) === '5' ? 'goalie' : 'skater'),
        outSlots: [8],
        groupNames: { skater: 'skaters', goalie: 'goalies' },
        splitsStats: false
    }
};

// The season-long row of a player's stats from one source: 1 is ESPN's projection, 0 what happened.
const rowOf = (player, source, season) => ((player && player.stats) || []).find(s => s
    && s.statSourceId === source && s.statSplitTypeId === 0 && s.seasonId === season && s.scoringPeriodId === 0) || null;

// ==== The model ====

/**
 * The matchup chance of the reader's own team, assembled and answered, with no storage in it:
 * handed the store as read, it hands back the next one and whether it changed.
 *
 * @param {FaceInputs} [inputs] What the app holds.
 * @param {?object} [store] The odds record as read; absent, an empty one.
 * @returns {{refusal: ?string, matchup: (object|undefined), sides: (?object|undefined), odds: (?object|undefined), oddsReason: (?string|undefined), word: (?string|undefined), shows: (?string|undefined), record: (object|undefined), earned: (object|undefined), marks: (object|undefined), store: (?object|undefined), write: (boolean|undefined)}}
 *   The model. A refusal carries its name and nothing else: 'no payload', 'no matchup', 'sport not
 *   supported', 'no pool' or 'no schedule'. Otherwise the sides, and the chance or the reason
 *   there is none: 'no harvest', which names the groups when only some have no day line, 'no
 *   spread' or 'no contest'.
 */
export function matchupFaceModel(inputs = {}, store = null) {
    const { payload, teamId, sport, pool, proSchedule, dayLinesOf = null, matchupMap, read = {}, asOf = null } = inputs || {};
    const status = payload && payload.status;
    const settings = (payload && payload.settings) || {};
    if (!payload || !status || !Array.isArray(payload.schedule)) return { refusal: 'no payload' };
    const scoringType = (settings.scoringSettings || {}).scoringType || '';
    // A roto league has no matchup at all, and neither does a season scored on total points.
    if (!/^H2H/.test(scoringType)) return { refusal: 'no matchup' };
    const table = SEAT_TABLES[sport];
    if (!table) return { refusal: 'sport not supported' };

    const game = payload.schedule.find(g => g && g.matchupPeriodId === status.currentMatchupPeriod && g.home && g.away
        && (key(g.home.teamId) === key(teamId) || key(g.away.teamId) === key(teamId)));
    if (!game) return { refusal: 'no matchup' };

    const entries = Array.isArray(pool) ? pool : ((pool && pool.players) || []);
    if (!entries.length) return { refusal: 'no pool' };
    const pooled = new Map(entries.map(e => [e && e.id, e && e.player]));

    const proTeams = (proSchedule && proSchedule.settings && proSchedule.settings.proTeams) || [];
    const today = status.latestScoringPeriod;
    const window = currentMatchupWindow(matchupMap, today);
    if (!proTeams.length || !window) return { refusal: 'no schedule' };

    // Games by club by period: left, and played. Today's are left unless ESPN has marked them final.
    const clubGames = {};
    const clubPlayed = {};
    proTeams.forEach(t => {
        clubGames[t.id] = {};
        clubPlayed[t.id] = {};
        Object.keys(t.proGamesByScoringPeriod || {}).forEach(period => {
            const games = t.proGamesByScoringPeriod[period] || [];
            const p = Number(period);
            const left = p > today ? games.length : (p === today ? games.filter(g => g.statsOfficial !== true).length : 0);
            if (left) clubGames[t.id][p] = left;
            if (games.length - left) clubPlayed[t.id][p] = games.length - left;
        });
    });
    const periodsLeft = [];
    for (let p = Math.max(today, window.start); p <= window.end; p += 1) periodsLeft.push(p);

    const season = payload.seasonId;
    const points = scoringType === 'H2H_POINTS';
    const mine = key(game.home.teamId) === key(teamId) ? game.home : game.away;
    const theirs = mine === game.home ? game.away : game.home;
    const rosterOf = side => ((side && side.rosterForCurrentScoringPeriod && side.rosterForCurrentScoringPeriod.entries) || []);

    // One roster entry as matchup-sides takes a player: joined to the pool for the two rows the roster view does not carry.
    const playerOf = entry => {
        const player = pooled.get(entry.playerId) || (entry.playerPoolEntry && entry.playerPoolEntry.player) || {};
        const group = table.groupOfPosition(player.defaultPositionId);
        const gamesId = table.gamesIdOf(group);
        const projected = rowOf(player, 1, season);
        const actual = rowOf(player, 0, season);
        const club = player.proTeamId;
        const played = Object.keys(clubPlayed[club] || {}).map(Number).sort((a, b) => a - b);
        const clubGamesPlayed = played.reduce((sum, p) => sum + clubPlayed[club][p], 0);
        const seasonGames = actual && actual.stats ? Number(actual.stats[gamesId]) : NaN;
        // One line a club game played since the player's first, a missed game empty.
        const lines = (dayLinesOf && dayLinesOf(entry.playerId)) || null;
        const seen = lines ? Object.keys(lines).map(Number).filter(p => p <= today) : [];
        const first = seen.length ? Math.min(...seen) : null;
        return {
            playerId: entry.playerId,
            lineupSlotId: entry.lineupSlotId,
            proTeamId: club,
            group,
            projected: projected ? projected.stats || null : null,
            gamesId,
            season: actual ? actual.stats || null : null,
            pointsPerGame: projected && Number.isFinite(projected.appliedAverage) ? projected.appliedAverage : null,
            share: seasonGames > 0 && clubGamesPlayed > 0 ? Math.min(1, seasonGames / clubGamesPlayed) : null,
            listed: null,
            dayLines: first === null ? [] : played.filter(p => p >= first).map(p => lines[p] || {}),
            starterStatusByProGame: player.starterStatusByProGame || null
        };
    };

    const scored = ((settings.scoringSettings || {}).scoringItems || []).map(i => i && i.statId).filter(id => id !== undefined && id !== null).map(key);
    const specs = RATE_COMPONENTS[sport] || [];
    const partsOf = spec => (spec.add ? spec.add.flatMap(part => { const sub = specs.find(s => s.out === key(part)); return sub ? partsOf(sub) : []; }) : [...(spec.num || []), ...(spec.den || [])]);
    const tracked = points ? ['points'] : [...new Set(scored.flatMap(id => { const spec = specs.find(s => s.out === id); return spec ? partsOf(spec).map(key) : [id]; }))];

    const sideOf = side => {
        const players = rosterOf(side).map(playerOf);
        if (points) return { points: read.pointsOf ? read.pointsOf(side) : 0, players };
        const tally = (read.tallyOf && read.tallyOf(side)) || {};
        const board = {};
        Object.keys(tally.scoreByStat || {}).forEach(id => { board[id] = Number((tally.scoreByStat[id] || {}).score); });
        // Total bases are not on the board; they are these four that are.
        if (tracked.includes('8') && board['8'] === undefined) {
            board['8'] = (board['1'] || 0) + (board['3'] || 0) + 2 * (board['4'] || 0) + 3 * (board['5'] || 0);
        }
        return { board, players };
    };
    const mySide = sideOf(mine);
    const theirSide = sideOf(theirs);

    // A pitcher's listed starts, when the listings reach the end of the matchup. Short of it the unannounced days would read as no start, so every pitcher is placed by share.
    if (table.splitsStats) {
        const pitchers = [...mySide.players, ...theirSide.players].filter(p => p.group === 'pitcher' && p.starterStatusByProGame)
            .map(p => ({ id: p.playerId, proTeamId: p.proTeamId, starterStatusByProGame: p.starterStatusByProGame }));
        const listings = countProjectedStarts(pitchers, buildGamePeriodIndex(proSchedule), { start: window.start, end: window.end }, today);
        let horizon = -Infinity;
        listings.byPlayer.forEach(entry => (entry.games || []).forEach(g => { if (Number(g.period) > horizon) horizon = Number(g.period); }));
        if (horizon >= window.end) {
            [...mySide.players, ...theirSide.players].forEach(p => { const entry = listings.byPlayer.get(p.playerId); if (entry) p.listed = entry.remaining; });
        }
    }

    // Seats by group, off the league's own lineup slots.
    const slotCounts = (settings.rosterSettings || {}).lineupSlotCounts || {};
    const benched = NON_STARTING_SLOTS[sport] || new Set();
    const seats = {};
    Object.keys(slotCounts).forEach(slot => {
        if (!(slotCounts[slot] > 0) || benched.has(Number(slot))) return;
        const group = table.groupOfSlot(slot);
        seats[group] = (seats[group] || 0) + slotCounts[slot];
    });

    // The floor: every player on a roster of the matchup being played, league-wide.
    const everyone = payload.schedule.filter(g => g && g.matchupPeriodId === status.currentMatchupPeriod)
        .flatMap(g => [g.home, g.away]).filter(Boolean).flatMap(side => rosterOf(side).map(playerOf));
    const tieSettings = settings.scoringSettings || {};
    const ctx = {
        sport,
        scoring: points ? 'points' : 'categories',
        scoredStatIds: scored,
        // The sport's own inverse ids. The two empty tables stop the helper reaching for the application's state, which a category league's direction does not depend on.
        inverseStatIds: [...leagueInverseIds(sport, {}, {})].map(key),
        rateSpecs: specs,
        // A league with no tie rule still carries a stat id of 0 beside it, which names nothing.
        tie: { rule: tieSettings.matchupTieRule || 'NONE', statId: tieSettings.matchupTieRule === 'STAT_POINTS' && tieSettings.matchupTieRuleBy !== undefined && tieSettings.matchupTieRuleBy !== null ? key(tieSettings.matchupTieRuleBy) : null },
        periodsLeft,
        clubGames,
        seats,
        groupStatIds: table.splitsStats ? { pitcher: tracked.filter(id => PITCHING_IDS.has(id)), hitter: tracked.filter(id => !PITCHING_IDS.has(id)) } : undefined,
        outSlots: table.outSlots,
        poolVariance: poolVariance(everyone, tracked)
    };
    const sides = matchupSides({ mine: mySide, theirs: theirSide }, ctx);

    // The chance, or the reason there is none. A spread nobody measured is not zero.
    const out = new Set(table.outSlots);
    // The groups of a side that have a game left and nobody with a day line. A group is judged by itself: its categories would otherwise go on with a spread of nothing, which reads as certain.
    const playsOn = p => periodsLeft.some(period => ((clubGames[p.proTeamId] || {})[period] || 0) > 0);
    const unmeasured = side => {
        const groups = new Map();
        side.players.forEach(p => {
            if (out.has(Number(p.lineupSlotId)) || !playsOn(p)) return;
            groups.set(p.group, groups.get(p.group) === true || p.dayLines.length > 0);
        });
        return { all: [...groups.keys()], missing: [...groups.keys()].filter(g => !groups.get(g)) };
    };
    let odds = null;
    let oddsReason = null;
    if (!sides) oddsReason = 'no contest';
    else if (unmeasured(mySide).missing.length || unmeasured(theirSide).missing.length) {
        // With no group measured on either side there is no harvest at all; otherwise the groups are named.
        const mineGroups = unmeasured(mySide);
        const theirGroups = unmeasured(theirSide);
        const nobody = mineGroups.missing.length === mineGroups.all.length && theirGroups.missing.length === theirGroups.all.length;
        const named = Object.keys(table.groupNames).filter(g => mineGroups.missing.includes(g) || theirGroups.missing.includes(g)).map(g => table.groupNames[g]);
        oddsReason = nobody ? 'no harvest' : `no harvest: ${named.join(', ')}`;
    }
    else if (points && (sides.mine.sd === null || sides.theirs.sd === null)) oddsReason = 'no spread';
    else odds = matchupOdds({ mine: sides.mine, theirs: sides.theirs }, sides.rule);

    // The record. The key is the sport and the league and carries nothing of the reader's.
    const leagueKey = `${sport}:${payload.id}`;
    let next = store;
    let recorded = false;
    let reason = 'no odds';
    if (odds) {
        const written = recordPrediction(store, { leagueKey, season, matchupPeriod: status.currentMatchupPeriod, day: today, chance: odds.chance, tie: odds.tie, lose: odds.lose, asOf });
        next = written.store;
        recorded = written.recorded;
        reason = written.reason;
    }
    // The finished matchups, off the league's own schedule, from the reader's side.
    const results = [];
    payload.schedule.forEach(g => {
        if (!g || !g.home || !g.away || !(g.matchupPeriodId < status.currentMatchupPeriod)) return;
        const home = key(g.home.teamId) === key(teamId);
        if (!home && key(g.away.teamId) !== key(teamId)) return;
        if (g.winner === 'TIE') results.push({ leagueKey, season, matchupPeriod: g.matchupPeriodId, result: 'tie' });
        else if (g.winner === 'HOME' || g.winner === 'AWAY') results.push({ leagueKey, season, matchupPeriod: g.matchupPeriodId, result: (g.winner === 'HOME') === home ? 'win' : 'loss' });
    });
    const scoredRecord = scorePredictions(next, results, { leagueKey });
    const earned = recordEarnsNumber(scoredRecord);

    return {
        refusal: null,
        matchup: { period: status.currentMatchupPeriod, day: today, days: [window.start, window.end], periodsLeft: periodsLeft.length, mine: mine.teamId, theirs: theirs.teamId },
        sides,
        odds,
        oddsReason,
        word: odds ? chanceWord(odds.chance, odds.tie) : null,
        // Baseball's number is shown from the first day; hockey's once its own record has earned it.
        shows: odds ? (sport === 'flb' || earned.earned ? 'number' : 'word') : null,
        record: { leagueKey, recorded, reason, scored: scoredRecord },
        earned,
        marks: { fallback: sides ? [...new Set([...sides.basis.mine.fallback, ...sides.basis.theirs.fallback])] : [], leftOut: sides ? sides.leftOut : [] },
        store: next,
        write: recorded
    };
}

/**
 * The model with the storage verbs: the store read once before it and written once after, and
 * only when a prediction was recorded.
 *
 * @param {FaceInputs} inputs What the app holds.
 * @param {object} [verbs]
 * @param {function(): (Promise<?object>|?object)} [verbs.readStore] Reads the odds record.
 * @param {function(object): (Promise<void>|void)} [verbs.writeStore] Writes it back.
 * @returns {Promise<object>} The model, less its store. A store that cannot be read is treated as
 *   empty and nothing is written, since a write would replace a record nobody could see.
 */
export async function matchupFace(inputs, { readStore, writeStore } = {}) {
    let store = null;
    let unreadable = false;
    try { store = readStore ? await readStore() : null; } catch (e) { unreadable = true; }
    const model = matchupFaceModel(inputs, store || null);
    if (model.refusal) return model;
    const { store: next, write, ...rest } = model;
    if (unreadable) return { ...rest, record: { ...rest.record, recorded: false, reason: 'store unreadable' } };
    if (write && writeStore) await writeStore(next);
    return rest;
}
