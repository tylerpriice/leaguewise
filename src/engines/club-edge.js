/**
 * How two clubs compare on the night they meet: a table of each club's figures per game, built
 * from players' per-day stat lines, and from it the edges a schedule card prints for one game.
 *
 * Three rules shape the table. Each day line is placed by its own club for that game, never the
 * player's current club, so a traded player's games stay where they were played. Everything
 * against a club is read off the other club's skaters in the same game, since a goalie is not
 * charged an empty-net goal. And a line counts as an appearance only when the player played. No
 * edge here is called goaltending: a club's save percentage did not pick winners when measured,
 * as docs/CLUB-EDGE-VALIDATION.md reports.
 *
 * Pure, and it imports nothing. No DOM, no application state, no network and no stat ids of its
 * own.
 *
 * Contract: tests/fixtures/club-edge.md
 * Tests: tests/club-edge.test.html
 * @module club-edge
 */
/**
 * The running fold of day lines: one raw record per club per game, the players already folded,
 * and counts of the lines left out.
 *
 * @typedef {object} ClubFold
 * @property {Map<string, object>} games The records, keyed by game and club.
 * @property {Set} players The players already folded.
 * @property {{noGame: number, notInGame: number, refolded: number, idle: number}} skipped How many lines were left out, by reason.
 */
/**
 * Every club's figures per game, each with its league rank.
 *
 * @typedef {object} ClubTable
 * @property {Map<*, {clubId: *, games: number, incomplete: number, figures: Object<string, {value: ?number, rank: ?number}>}>} clubs The clubs.
 * @property {{ranked: number, shots: ?number, goals: ?number}} league How many clubs are ranked, and the mean shots and goals per club-game over them.
 * @property {?number} through The last scoring period counted.
 */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const keyOf = (gameId, clubId) => `${gameId}|${clubId}`;
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/**
 * Folds day lines into one raw record per club per game. The fold is additive: a fold handed back
 * in grows, so lines can arrive in chunks.
 *
 * A player is folded once. A later landing of the same player is skipped whole and counted, since
 * the fold keeps club records and no player's days. The game index may be null when the schedule
 * has not arrived; a record is then keyed by the line's own game and club, and clubGameRows fills
 * in the rest.
 *
 * @param {Array<{playerId: *, isGoalie: boolean, proTeamId: number, externalId: *, period: number, totals: Object<string, number>}>} lines The day lines.
 * @param {?Map<string, {home: number, away: number, period: number, date: number}>} gameIndex Pro games by id, or null.
 * @param {object} [options]
 * @param {Object<string, string>} [options.ids] The caller's stat ids for played, goals, shots, ppGoals, starts, wins, saves, shotsFaced and goalsAllowed. An id left out reads as zero, and with no played id every line counts as an appearance.
 * @param {?ClubFold} [options.into] A fold to add to.
 * @param {function(*): number} [options.numberOf] Reads a stat value as a number.
 * @returns {ClubFold} The fold.
 */
export function foldClubGames(lines, gameIndex, { ids = {}, into = null, numberOf = num } = {}) {
    const fold = into || { games: new Map(), players: new Set(), skipped: { noGame: 0, notInGame: 0, refolded: 0, idle: 0 } };
    const landing = new Set();
    const read = (totals, id) => (id === undefined || id === null ? 0 : numberOf(totals[id]));
    (lines || []).forEach(line => {
        if (!line || line.playerId === null || line.playerId === undefined) return;
        if (fold.players.has(line.playerId)) { fold.skipped.refolded++; return; }
        const hasIndex = !!gameIndex && typeof gameIndex.get === 'function';
        const game = hasIndex ? gameIndex.get(String(line.externalId)) : null;
        if (line.externalId === null || line.externalId === undefined || (hasIndex && !game)) { fold.skipped.noGame++; return; }
        let isHome = null;
        if (game) {
            isHome = sameId(line.proTeamId, game.home);
            if (!isHome && !sameId(line.proTeamId, game.away)) { fold.skipped.notInGame++; return; }
        } else if (line.proTeamId === null || line.proTeamId === undefined) { fold.skipped.notInGame++; return; }
        landing.add(line.playerId);
        const totals = line.totals || {};
        if (ids.played !== undefined && ids.played !== null && read(totals, ids.played) < 1) { fold.skipped.idle++; return; }

        const clubId = game ? (isHome ? game.home : game.away) : line.proTeamId;
        const key = keyOf(line.externalId, clubId);
        let rec = fold.games.get(key);
        if (!rec) {
            rec = {
                gameId: String(line.externalId), clubId, opponentId: game ? (isHome ? game.away : game.home) : null, isHome,
                period: game ? (game.period ?? null) : (line.period ?? null), date: game ? (game.date ?? null) : null,
                dressed: 0, goals: 0, shots: 0, ppGoals: 0,
                saves: 0, shotsFaced: 0, goalsAllowed: 0, starters: [], won: false
            };
            fold.games.set(key, rec);
        }
        if (line.isGoalie) {
            rec.saves += read(totals, ids.saves);
            rec.shotsFaced += read(totals, ids.shotsFaced);
            rec.goalsAllowed += read(totals, ids.goalsAllowed);
            if (read(totals, ids.starts) >= 1) rec.starters.push(line.playerId);
            if (read(totals, ids.wins) >= 1) rec.won = true;
        } else {
            rec.dressed++;
            rec.goals += read(totals, ids.goals);
            rec.shots += read(totals, ids.shots);
            rec.ppGoals += read(totals, ids.ppGoals);
        }
    });
    landing.forEach(id => fold.players.add(id));
    return fold;
}

/**
 * Each club's games in the order they were played, with what was done against it taken from the
 * other club's record of the same game. A game only one club has lines for carries null for
 * everything against it.
 *
 * @param {ClubFold} fold The fold.
 * @param {?Map} [gameIndex] Pro games by id, to fill the side and the date on a record folded without one.
 * @returns {Map<*, Array<{gameId: string, period: ?number, date: ?number, clubId: *, opponentId: *, isHome: ?boolean, dressed: number, goalsFor: number, shotsFor: number, ppGoalsFor: number, goalsAgainst: ?number, shotsAgainst: ?number, ppGoalsAgainst: ?number, saves: number, shotsFaced: number, goalsAllowed: number, starterId: *, won: ?boolean}>>}
 *   The rows by club. The starter is the one goalie credited with the start, or null for none or
 *   two. The win is true on this side's goalie's win, false when the other side holds it, and
 *   null when neither does.
 */
export function clubGameRows(fold, gameIndex = null) {
    const byClub = new Map();
    if (!fold || !fold.games) return byClub;
    const byGame = new Map();
    fold.games.forEach(rec => { if (!byGame.has(rec.gameId)) byGame.set(rec.gameId, []); byGame.get(rec.gameId).push(rec); });
    const hasIndex = !!gameIndex && typeof gameIndex.get === 'function';
    fold.games.forEach(stored => {
        const rec = { ...stored };
        const inGame = byGame.get(rec.gameId);
        if (rec.opponentId === null) {
            const game = hasIndex ? gameIndex.get(rec.gameId) : null;
            if (game && (sameId(rec.clubId, game.home) || sameId(rec.clubId, game.away))) {
                rec.isHome = sameId(rec.clubId, game.home);
                rec.opponentId = rec.isHome ? game.away : game.home;
                rec.date = game.date ?? null;
                if (rec.period === null) rec.period = game.period ?? null;
            } else {
                const others = inGame.filter(o => o !== stored);
                if (others.length === 1) rec.opponentId = others[0].clubId;
            }
        }
        const opp = rec.opponentId === null ? null : (inGame.find(o => o !== stored && sameId(o.clubId, rec.opponentId)) || null);
        const row = {
            gameId: rec.gameId, period: rec.period, date: rec.date,
            clubId: rec.clubId, opponentId: rec.opponentId, isHome: rec.isHome, dressed: rec.dressed,
            goalsFor: rec.goals, shotsFor: rec.shots, ppGoalsFor: rec.ppGoals,
            goalsAgainst: opp ? opp.goals : null, shotsAgainst: opp ? opp.shots : null, ppGoalsAgainst: opp ? opp.ppGoals : null,
            saves: rec.saves, shotsFaced: rec.shotsFaced, goalsAllowed: rec.goalsAllowed,
            starterId: rec.starters.length === 1 ? rec.starters[0] : null,
            won: rec.won ? true : (opp && opp.won ? false : null)
        };
        if (!byClub.has(rec.clubId)) byClub.set(rec.clubId, []);
        byClub.get(rec.clubId).push(row);
    });
    const at = (v) => (v === null || v === undefined ? Infinity : Number(v));
    byClub.forEach(rows => rows.sort((a, b) => (at(a.date) - at(b.date)) || (at(a.period) - at(b.period)) || String(a.gameId).localeCompare(String(b.gameId))));
    return byClub;
}

// The figures a club is ranked on, per game played. Which way is better is from the side of the club that owns the number, so rank 1 always reads best in the league at this. The differentials are per game too.
const FIGURES = [
    { key: 'shotsFor', better: 'high', of: s => s.shotsFor },
    { key: 'shotsAgainst', better: 'low', of: s => s.shotsAgainst },
    { key: 'shotDiff', better: 'high', of: s => s.shotsFor - s.shotsAgainst },
    { key: 'goalsFor', better: 'high', of: s => s.goalsFor },
    { key: 'goalsAgainst', better: 'low', of: s => s.goalsAgainst },
    { key: 'goalDiff', better: 'high', of: s => s.goalsFor - s.goalsAgainst },
    { key: 'ppGoalsFor', better: 'high', of: s => s.ppGoalsFor },
    { key: 'ppGoalsAgainst', better: 'low', of: s => s.ppGoalsAgainst }
];

/**
 * Every club's figures per game to date, each with its league rank. Only a game both clubs have
 * lines for is counted, so a club's for and against cover the same games. Level clubs share a
 * rank and the next rank is skipped.
 *
 * @param {ClubFold|Map} fold The fold, or the rows from clubGameRows.
 * @param {object} [options]
 * @param {?number} [options.through] The last scoring period counted. Pass the last completed one.
 * @param {number} [options.minGames=1] A club with fewer counted games keeps its values, is not ranked, and is left out of the others' ranks.
 * @returns {ClubTable} The table.
 */
export function clubTable(fold, { through = null, minGames = 1 } = {}) {
    const rowsByClub = fold instanceof Map ? fold : clubGameRows(fold);
    const clubs = new Map();
    rowsByClub.forEach((rows, clubId) => {
        const sums = { games: 0, incomplete: 0, shotsFor: 0, shotsAgainst: 0, goalsFor: 0, goalsAgainst: 0, ppGoalsFor: 0, ppGoalsAgainst: 0 };
        rows.forEach(r => {
            if (through !== null && !(Number(r.period) <= through)) return;
            if (r.goalsAgainst === null) { sums.incomplete++; return; }
            sums.games++;
            sums.shotsFor += r.shotsFor; sums.shotsAgainst += r.shotsAgainst;
            sums.goalsFor += r.goalsFor; sums.goalsAgainst += r.goalsAgainst;
            sums.ppGoalsFor += r.ppGoalsFor; sums.ppGoalsAgainst += r.ppGoalsAgainst;
        });
        const figures = {};
        FIGURES.forEach(f => { figures[f.key] = { value: sums.games ? f.of(sums) / sums.games : null, rank: null }; });
        clubs.set(clubId, { clubId, games: sums.games, incomplete: sums.incomplete, figures, sums });
    });

    const ranked = [...clubs.values()].filter(c => c.games >= Math.max(1, minGames));
    FIGURES.forEach(f => {
        const values = ranked.map(c => c.figures[f.key].value);
        ranked.forEach(c => {
            const v = c.figures[f.key].value;
            c.figures[f.key].rank = 1 + values.filter(o => (f.better === 'high' ? o > v : o < v)).length;
        });
    });
    const games = ranked.reduce((a, c) => a + c.games, 0);
    const league = {
        ranked: ranked.length,
        shots: games ? ranked.reduce((a, c) => a + c.sums.shotsFor, 0) / games : null,
        goals: games ? ranked.reduce((a, c) => a + c.sums.goalsFor, 0) / games : null
    };
    clubs.forEach(c => { delete c.sums; });
    return { clubs, league, through };
}

/**
 * The edges of one game, from each club's own side. Each edge sets one of my club's figures
 * against one of the opponent's, with the gap between them and who it favours.
 *
 * The shots edge is for a skater: my club's shots for, against what the opponent allows, as shots
 * above an average game. The goals edge is goal differential, mine against theirs. The shots-faced
 * edge is for a goalie: what my club allows, against the opponent's shots for, as shots below an
 * average game.
 *
 * @param {{home: number, away: number}} game The game's two clubs.
 * @param {ClubTable} table The table.
 * @returns {?{home: object[], away: object[]}} Three edges per side, each with its key, both figures with their ranks, the gap, and 'mine', 'theirs' or null on a gap of zero. Null when either club is missing or not ranked.
 */
export function gameEdges(game, table) {
    if (!game || !table || !table.clubs || !table.league) return null;
    const find = (id) => { let hit = null; table.clubs.forEach((c, k) => { if (hit === null && sameId(k, id)) hit = c; }); return hit; };
    const home = find(game.home), away = find(game.away);
    const usable = (c) => !!c && c.figures.shotsFor.rank !== null;
    if (!usable(home) || !usable(away) || table.league.shots === null) return null;
    const L = table.league.shots;
    const side = (c, figure) => ({ figure, value: c.figures[figure].value, rank: c.figures[figure].rank });
    const edge = (key, mine, theirs, gap) => ({ key, mine, theirs, gap, ahead: gap > 0 ? 'mine' : (gap < 0 ? 'theirs' : null) });
    const view = (me, them) => {
        const shotsFor = side(me, 'shotsFor'), allowed = side(them, 'shotsAgainst');
        const myDiff = side(me, 'goalDiff'), theirDiff = side(them, 'goalDiff');
        const myAllowed = side(me, 'shotsAgainst'), theirShots = side(them, 'shotsFor');
        return [
            edge('shots', shotsFor, allowed, shotsFor.value + allowed.value - 2 * L),
            edge('goals', myDiff, theirDiff, myDiff.value - theirDiff.value),
            edge('shotsFaced', myAllowed, theirShots, 2 * L - myAllowed.value - theirShots.value)
        ];
    };
    return { home: view(home, away), away: view(away, home) };
}
