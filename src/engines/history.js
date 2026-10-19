/**
 * League History's arithmetic: franchises across seasons, all-time records, head-to-head series,
 * rivalries, careers, and one season reduced to its standings and facts.
 *
 * Pure, and it imports nothing. No DOM, no application state and no network. Three facts about
 * ESPN's data shape everything here. An owner's id survives across seasons and a team's name does
 * not. A team id is not a franchise, since a slot can change hands. And one league can change
 * format between seasons, so anything that counts games has to know which seasons it may count: a
 * roto season has no record and no matchups at all.
 *
 * Tests: tests/history.test.html
 * @module history
 */
/**
 * One franchise's line in one season.
 *
 * @typedef {object} SeasonFranchise
 * @property {?string} key The franchise key, from franchiseKeyOf.
 * @property {number} teamId The team id the franchise held that season.
 * @property {string} name The team's name that season.
 * @property {string} abbrev The team's abbreviation that season.
 * @property {?string} logo The logo url as ESPN filed it, not checked against any host rule.
 * @property {?number} wins Null in a roto season, which keeps no record. The same for losses and ties.
 * @property {?number} losses
 * @property {?number} ties
 * @property {?number} points The season's points in a points or roto season, and null otherwise.
 * @property {?number} finalRank ESPN's final rank, or null where none was filed.
 */
/**
 * One season reduced to what League History reads. Everything downstream reads this and never
 * the raw payload, so the format is decided once.
 *
 * @typedef {object} LeagueSeason
 * @property {number} year The season.
 * @property {('h2h'|'points'|'roto')} format How the season was scored.
 * @property {boolean} countsTowardRecords False for a roto season.
 * @property {boolean} finished Whether the season is over.
 * @property {?string[]} incomplete What the payload lacks, of 'categories', 'teams' and 'matchups', or null.
 * @property {?string} championKey The champion's franchise key, or null.
 * @property {SeasonFranchise[]} franchises Every team of the season.
 * @property {string[]} statIds The scored stat ids.
 */
/**
 * One franchise across every season it played.
 *
 * @typedef {object} Franchise
 * @property {string} key The franchise key.
 * @property {string} name Its most recent name.
 * @property {string} abbrev Its most recent abbreviation.
 * @property {?string} logo Its most recent logo url.
 * @property {number[]} seasons The years it played, ascending.
 * @property {string[]} formerNames Earlier names, without the current one.
 */
/**
 * One matchup as a neutral row, both sides valued the same way.
 *
 * @typedef {object} MatchupRow
 * @property {number} week The matchup period.
 * @property {boolean} postseason Whether it was a playoff game.
 * @property {{key: ?string, teamId: number, value: number, catWins: ?number}} home
 * @property {{key: ?string, teamId: number, value: number, catWins: ?number}} away
 * @property {boolean} decided Whether the matchup has a result.
 * @property {boolean} tie Whether ESPN filed it as a tie.
 * @property {?object} winner The winning side, or null.
 * @property {?object} loser The losing side, or null.
 * @property {number} margin The gap between the two values.
 */
/**
 * One fact of a season: who, how much, and when.
 *
 * @typedef {object} SeasonFact
 * @property {?string} key The franchise key.
 * @property {?string} [against] The other side's franchise key, for a game fact.
 * @property {number} value The figure.
 * @property {?string} when The matchup it happened in, such as 'M12', or null for a season total.
 */

// ESPN writes an owner's id with braces in one payload and without in another, and in either case.
function normSwid(v) {
    return String(v || '').replace(/[{}]/g, '').toUpperCase();
}

/**
 * The key that identifies a franchise across seasons: the id of the team's owner where there is one. The
 * team id is the fallback for a season with no ownership data, prefixed so it cannot collide with an
 * owner's id.
 *
 * @param {object} team A team from a league payload.
 * @returns {?string} The key, or null for a team with neither an owner nor an id.
 */
export function franchiseKeyOf(team) {
    const swid = normSwid(team && (team.primaryOwner || (team.owners || [])[0]));
    if (swid) return swid;
    const id = team && team.id;
    return id === null || id === undefined ? null : `team:${id}`;
}

/**
 * A team's abbreviation: the league's own, or the first four characters of the team's name in
 * capitals for a team that never set one.
 *
 * @param {object} team A team from a league payload.
 * @returns {string} The abbreviation, empty for no team.
 */
export function teamAbbrev(team) {
    if (!team) return '';
    const explicit = (team.abbrev || '').trim();
    if (explicit) return explicit;
    return teamDisplayName(team).substring(0, 4).toUpperCase();
}

function teamDisplayName(team) {
    if (!team) return '';
    const name = (team.name || '').trim();
    if (name) return name;
    return `${(team.location || '').trim()} ${(team.nickname || '').trim()}`.trim();
}

/**
 * How one season was scored, read from that season's own settings. One league can answer
 * differently from year to year.
 *
 * @param {object} payload The season's league payload.
 * @returns {('h2h'|'points'|'roto')} The format. Anything that is not roto or head-to-head points reads 'h2h'.
 */
export function seasonFormat(payload) {
    const type = payload?.settings?.scoringSettings?.scoringType || '';
    if (type === 'ROTO') return 'roto';
    if (type === 'H2H_POINTS') return 'points';
    return 'h2h';
}

/**
 * The season's champion, by the rule its format allows. Head to head: the winner of the last
 * decided game in the winners' bracket. Roto: the one team ESPN ranked first at the end.
 *
 * @param {object} payload The season's league payload.
 * @returns {?string} The champion's franchise key. Null for an unfinished season and for a tie at the top.
 */
export function championKeyOf(payload) {
    if (!payload || !Array.isArray(payload.teams)) return null;
    const byId = new Map(payload.teams.map(t => [t.id, t]));

    if (seasonFormat(payload) === 'roto') {
        const won = payload.teams.filter(t => t.rankCalculatedFinal === 1);
        // Ranks are not unique. A tie at the top is reported as no champion, never as one picked from the tied.
        return won.length === 1 ? franchiseKeyOf(won[0]) : null;
    }

    let finalWeek = null;
    let champion = null;
    (payload.schedule || []).forEach(game => {
        if (game.playoffTierType !== 'WINNERS_BRACKET') return;
        if (finalWeek === null || game.matchupPeriodId > finalWeek) {
            finalWeek = game.matchupPeriodId;
            champion = null;
        }
        if (game.matchupPeriodId !== finalWeek) return;
        if (!game.winner || game.winner === 'UNDECIDED' || game.winner === 'TIE') return;
        const side = game.winner === 'HOME' ? game.home : game.away;
        champion = byId.get(side && side.teamId) || null;
    });
    return champion ? franchiseKeyOf(champion) : null;
}

/**
 * Whether a season is over, from ESPN's own pair of scoring periods: how far the season has got
 * against where it ends.
 *
 * seasonIsFinished in season-state.js asks the same of the live league, and the two differ in two
 * places: when the latest period equals the final one this is true and that is false, and when a
 * field is missing this is true and that is false. Every finished season measured reads latest
 * one past final, where the two agree.
 *
 * @param {object} payload The season's league payload.
 * @returns {boolean} True once the latest period has reached the final one. Also true when either is missing, so a season nobody can measure is treated as settled.
 */
export function seasonFinished(payload) {
    const status = (payload && payload.status) || {};
    const latest = Number(status.latestScoringPeriod);
    const final = Number(status.finalScoringPeriod);
    if (Number.isFinite(latest) && Number.isFinite(final)) return latest >= final;
    return true;
}

/**
 * Reduces one season's payload to what League History reads.
 *
 * @param {object} payload The season's league payload.
 * @returns {?LeagueSeason} The season, or null for a payload with no teams list.
 */
export function summarizeSeason(payload) {
    if (!payload || !Array.isArray(payload.teams)) return null;
    const format = seasonFormat(payload);
    const counted = format !== 'roto';
    const franchises = payload.teams.map(team => {
        const overall = (team.record && team.record.overall) || {};
        return {
            key: franchiseKeyOf(team),
            teamId: team.id,
            name: teamDisplayName(team),
            abbrev: teamAbbrev(team),
            // Carried as ESPN filed it and not checked. Whether the url may be loaded is for whoever renders it; images.js owns that rule.
            logo: team.logo || null,
            // A roto season has no record. Nulls, not zeros, so a franchise that has only played roto shows a blank and not 0-0-0.
            wins: counted ? (overall.wins || 0) : null,
            losses: counted ? (overall.losses || 0) : null,
            ties: counted ? (overall.ties || 0) : null,
            // The season's points, in the two formats that keep them: a points league and a roto league, where the figure is the roto standings total. A head-to-head categories season files zero on every team, which is the absence of a measurement, so it reads null.
            points: (format === 'points' || format === 'roto')
                ? (Number.isFinite(team.points) ? team.points : null)
                : null,
            finalRank: Number.isFinite(team.rankCalculatedFinal) && team.rankCalculatedFinal > 0
                ? team.rankCalculatedFinal
                : null
        };
    });
    // A season is incomplete by the fields the view reads, not by its age. With no categories the category table cannot be filled, with no teams there is nothing to say, and a head-to-head season with no schedule has no champion and no grid.
    const statIds = (payload.settings?.scoringSettings?.scoringItems || [])
        .map(i => String(i.statId)).filter(Boolean);
    const gaps = [];
    if (!statIds.length) gaps.push('categories');
    if (!franchises.length) gaps.push('teams');
    if (counted && !(payload.schedule || []).length) gaps.push('matchups');

    return {
        year: payload.seasonId,
        format,
        countsTowardRecords: counted,
        finished: seasonFinished(payload),
        // Named, not counted, so the view can say what is missing.
        incomplete: gaps.length ? gaps : null,
        championKey: championKeyOf(payload),
        franchises,
        statIds
    };
}

/**
 * Every franchise that ever played, under its most recent name.
 *
 * @param {LeagueSeason[]} seasons The seasons, in any order.
 * @returns {Franchise[]} One row per franchise, in the order first seen from the earliest season.
 */
export function buildFranchises(seasons) {
    const byKey = new Map();
    [...seasons].filter(Boolean).sort((a, b) => a.year - b.year).forEach(season => {
        season.franchises.forEach(f => {
            if (!f.key) return;
            const prev = byKey.get(f.key);
            if (prev) {
                prev.name = f.name;
                // The latest season's abbreviation, as with the name: a franchise that renamed itself is called what it is called now.
                prev.abbrev = f.abbrev;
                prev.logo = f.logo;
                prev.seasons.push(season.year);
                if (!prev.formerNames.includes(f.name)) prev.formerNames.push(f.name);
            } else {
                byKey.set(f.key, {
                    key: f.key, name: f.name, abbrev: f.abbrev, logo: f.logo,
                    seasons: [season.year], formerNames: [f.name]
                });
            }
        });
    });
    // The current name is not a former name.
    byKey.forEach(f => { f.formerNames = f.formerNames.filter(n => n !== f.name); });
    return [...byKey.values()];
}

/**
 * All-time records per franchise. Only seasons whose format keeps a record add to it, and those
 * years are returned so a page can say what the record covers.
 *
 * @param {LeagueSeason[]} seasons The seasons, in any order.
 * @returns {{rows: Array<{key: string, name: string, seasonsPlayed: number, wins: number, losses: number, ties: number, titles: number, recordSeasons: number, winPct: ?number}>, countedYears: number[]}}
 *   The rows, most titles first, then by win share, then by wins; and the years that count.
 */
export function allTimeRecords(seasons) {
    const rows = new Map();
    const list = [...seasons].filter(Boolean).sort((a, b) => a.year - b.year);
    const countedYears = list.filter(s => s.countsTowardRecords).map(s => s.year);
    list.forEach(season => {
        season.franchises.forEach(f => {
            if (!f.key) return;
            if (!rows.has(f.key)) {
                rows.set(f.key, {
                    key: f.key, name: f.name, seasonsPlayed: 0,
                    wins: 0, losses: 0, ties: 0, titles: 0, recordSeasons: 0
                });
            }
            const row = rows.get(f.key);
            row.name = f.name;
            row.seasonsPlayed += 1;
            if (season.countsTowardRecords) {
                row.wins += f.wins || 0;
                row.losses += f.losses || 0;
                row.ties += f.ties || 0;
                row.recordSeasons += 1;
            }
            if (season.championKey && season.championKey === f.key) row.titles += 1;
        });
    });
    const out = [...rows.values()].map(r => {
        const games = r.wins + r.losses + r.ties;
        // A tie is half a win. Null, not zero, when a franchise has never played a season that keeps a record.
        return { ...r, winPct: games ? (r.wins + r.ties / 2) / games : null };
    });
    out.sort((a, b) => (b.titles - a.titles)
        || ((b.winPct === null ? -1 : b.winPct) - (a.winPct === null ? -1 : a.winPct))
        || (b.wins - a.wins));
    return { rows: out, countedYears };
}

/**
 * Each franchise's titles, the year of its last one, and how many seasons it has played since.
 *
 * A season counts only when it is finished and has a champion. Seasons are counted per franchise,
 * so a year a franchise sat out is not a year it failed to win.
 *
 * @param {LeagueSeason[]} seasons The seasons, in any order.
 * @returns {Array<{franchiseKey: string, titles: number, lastTitleYear: ?number, seasonsSince: number}>}
 *   One row per franchise, in the order first seen. A franchise that never won reads the seasons
 *   it has played.
 */
export function droughtsOf(seasons) {
    const rows = new Map();
    [...seasons].filter(Boolean).sort((a, b) => a.year - b.year).forEach(season => {
        const counts = season.finished !== false && !!season.championKey;
        season.franchises.forEach(f => {
            if (!f.key) return;
            if (!rows.has(f.key)) {
                rows.set(f.key, { franchiseKey: f.key, titles: 0, lastTitleYear: null, seasonsSince: 0 });
            }
            if (!counts) return;
            const row = rows.get(f.key);
            if (season.championKey === f.key) {
                row.titles += 1;
                row.lastTitleYear = season.year;
                row.seasonsSince = 0;
            } else {
                row.seasonsSince += 1;
            }
        });
    });
    return [...rows.values()];
}

/**
 * Writes a record as text, the one formatter every page uses. A zero tie count is dropped.
 *
 * @param {number} wins
 * @param {number} losses
 * @param {number} ties
 * @returns {string} Such as '54-9' or '11-9-1'.
 */
export function recordText(wins, losses, ties) {
    const w = Number(wins) || 0;
    const l = Number(losses) || 0;
    const t = Number(ties) || 0;
    return `${w}-${l}${t ? `-${t}` : ''}`;
}

/**
 * Whether a schedule entry was a playoff game, by ESPN's own tier field. Consolation games count.
 *
 * @param {object} game A schedule entry.
 * @returns {boolean} True for any tier other than none.
 */
export function isPostseasonGame(game) {
    const tier = game && game.playoffTierType;
    return !!tier && tier !== 'NONE';
}

/**
 * Every franchise against every other, from head-to-head seasons. The record is the regular
 * season's, which is what ESPN's own team records count, so it agrees with the standings.
 * Postseason meetings are counted beside it and not folded in.
 *
 * @param {LeagueSeason[]} seasons The seasons.
 * @param {Object<number, object>} payloadsByYear Each season's league payload, by year.
 * @returns {Array<{a: string, b: string, aWins: number, bWins: number, ties: number, postseason: number}>}
 *   One entry per pair that met, with a the lower key, so one entry reads either way round.
 */
export function headToHead(seasons, payloadsByYear) {
    const pairs = new Map();
    const entry = (aKey, bKey) => {
        const [x, y] = aKey < bKey ? [aKey, bKey] : [bKey, aKey];
        const id = `${x}|${y}`;
        if (!pairs.has(id)) pairs.set(id, { a: x, b: y, aWins: 0, bWins: 0, ties: 0, postseason: 0 });
        return pairs.get(id);
    };
    const bump = (aKey, bKey, result) => {
        if (!aKey || !bKey || aKey === bKey) return;
        const rec = entry(aKey, bKey);
        if (result === 'TIE') { rec.ties += 1; return; }
        const winnerIsX = (result === aKey) === (rec.a === aKey);
        if (winnerIsX) rec.aWins += 1; else rec.bWins += 1;
    };
    // Counted, and not folded into the record. Two franchises whose only meeting was a playoff game still have a pair entry, with an empty record, so the view does not call them never met.
    const bumpPostseason = (aKey, bKey) => {
        if (!aKey || !bKey || aKey === bKey) return;
        entry(aKey, bKey).postseason += 1;
    };

    [...seasons].filter(Boolean).forEach(season => {
        if (!season.countsTowardRecords) return;
        const payload = payloadsByYear && payloadsByYear[season.year];
        if (!payload || !Array.isArray(payload.schedule)) return;
        const keyOfTeam = new Map(season.franchises.map(f => [f.teamId, f.key]));
        payload.schedule.forEach(game => {
            const home = game.home && keyOfTeam.get(game.home.teamId);
            const away = game.away && keyOfTeam.get(game.away.teamId);
            // A bye is a schedule entry with one side. It is nobody's loss.
            if (!home || !away) return;
            if (!game.winner || game.winner === 'UNDECIDED') return;
            if (isPostseasonGame(game)) { bumpPostseason(home, away); return; }
            if (game.winner === 'TIE') { bump(home, away, 'TIE'); return; }
            bump(home, away, game.winner === 'HOME' ? home : away);
        });
    });
    return [...pairs.values()];
}

/**
 * Every category the league ever scored, with the seasons each was scored in.
 *
 * @param {LeagueSeason[]} seasons The seasons, in any order.
 * @returns {{totalSeasons: number, years: number[], stats: Array<{statId: string, scoredIn: number[], coverage: number}>}}
 *   The categories, the most covered first.
 */
export function categoryUnion(seasons) {
    const list = [...seasons].filter(Boolean).sort((a, b) => a.year - b.year);
    const years = list.map(s => s.year);
    const byStat = new Map();
    list.forEach(season => {
        season.statIds.forEach(id => {
            if (!byStat.has(id)) byStat.set(id, []);
            if (!byStat.get(id).includes(season.year)) byStat.get(id).push(season.year);
        });
    });
    return {
        totalSeasons: years.length,
        years,
        stats: [...byStat.entries()]
            .map(([statId, scoredIn]) => ({ statId, scoredIn, coverage: scoredIn.length }))
            // Most covered first: a category every season scored is the one worth reading across.
            .sort((a, b) => (b.coverage - a.coverage) || (a.statId.localeCompare(b.statId)))
    };
}

/**
 * A rate across seasons, from summed components. The components are summed first and divided
 * once; an average of season rates would weigh a short season like a full one.
 *
 * @param {Object<string, number>} componentTotals The summed components by stat id.
 * @param {{numerator: string[], denominator: string[], scale: (number|undefined)}} spec The stat ids to sum above and below the line.
 * @returns {?number} The rate. Null when a component is missing or the denominator is zero.
 */
export function careerRate(componentTotals, spec) {
    if (!spec || !Array.isArray(spec.numerator) || !Array.isArray(spec.denominator)) return null;
    const sum = (ids) => ids.reduce((total, id) => {
        const v = Number(componentTotals[id]);
        return total + (Number.isFinite(v) ? v : 0);
    }, 0);
    const missing = [...spec.numerator, ...spec.denominator]
        .some(id => componentTotals[id] === undefined || componentTotals[id] === null);
    if (missing) return null;
    const den = sum(spec.denominator);
    if (!den) return null;
    const value = sum(spec.numerator) / den;
    return Number.isFinite(value) ? value * (spec.scale || 1) : null;
}

// A player's career in this league. The player id is stable across seasons and the name is not, so the most recent name is shown. Format does not matter here: what is summed is raw components, recorded the same way however a season is scored. Only players a franchise rostered are counted.
function seasonTotalsOf(entry) {
    const stats = (entry && entry.player && entry.player.stats) || [];
    // Source 0 is real and not projected, and split 0 is the season total. Both are needed, since the same array carries projections and splits by period.
    const block = stats.find(s => s.statSourceId === 0 && s.statSplitTypeId === 0);
    return (block && block.stats) || null;
}

/**
 * Each player's career in this league: the seasons played, the franchises that held the player,
 * and the summed season totals.
 *
 * @param {Object<number, {players: object[]}>} poolsByYear Each season's player pool.
 * @param {Object<number, LeagueSeason>} seasonsByYear Each season's summary.
 * @param {Object<number, Map<number, number[]>>} [ownersByYear] Per season, every team that held each player at any point. Without it the pool's own team field is used.
 * @returns {Array<{id: number, name: string, eligibleSlots: number[], defaultPositionId: ?number, seasons: number[], franchiseKeys: string[], totals: Object<string, number>}>}
 *   One row per player, most seasons first, then by name.
 */
export function buildCareers(poolsByYear, seasonsByYear, ownersByYear) {
    const players = new Map();
    const years = Object.keys(poolsByYear || {}).map(Number).sort((a, b) => a - b);

    years.forEach(year => {
        const pool = poolsByYear[year];
        const season = seasonsByYear ? seasonsByYear[year] : null;
        const owners = (ownersByYear && ownersByYear[year]) || null;
        const franchiseOfTeam = new Map((season ? season.franchises : []).map(f => [f.teamId, f]));
        ((pool && pool.players) || []).forEach(entry => {
            // Who held the player that season, not who holds the player now. The pool's own team field is the roster at the moment it was fetched, so a player dropped earlier would lose the season and its stats. The transaction log answers it, and any stint counts. The pool's field stays as the fallback for a season whose log could not be read.
            const entryId = entry.id || (entry.player || {}).id;
            const held = (owners && owners.get(entryId)) || [];
            const teamIds = held.length ? held : (entry.onTeamId ? [entry.onTeamId] : []);
            if (!teamIds.length) return;
            const info = entry.player || {};
            const id = entry.id || info.id;
            if (id === null || id === undefined) return;
            const totals = seasonTotalsOf(entry);
            if (!totals) return;

            if (!players.has(id)) {
                players.set(id, { id, name: '', eligibleSlots: [], defaultPositionId: null, seasons: [], franchiseKeys: [], totals: {} });
            }
            const row = players.get(id);
            // Years ascend, so the last write is the most recent name. Eligibility is treated the same way: a player is grouped by the position played now.
            if (info.fullName) row.name = info.fullName;
            // The pool carries eligible slots and not positions. Decoding them is the caller's, since the slot map differs by sport.
            if (Array.isArray(info.eligibleSlots)) row.eligibleSlots = info.eligibleSlots;
            if (Number.isFinite(info.defaultPositionId)) row.defaultPositionId = info.defaultPositionId;
            if (!row.seasons.includes(year)) row.seasons.push(year);
            teamIds.forEach(teamId => {
                const franchise = franchiseOfTeam.get(teamId);
                if (franchise && franchise.key && !row.franchiseKeys.includes(franchise.key)) {
                    row.franchiseKeys.push(franchise.key);
                }
            });
            Object.keys(totals).forEach(statId => {
                const v = Number(totals[statId]);
                if (!Number.isFinite(v)) return;
                row.totals[statId] = (row.totals[statId] || 0) + v;
            });
        });
    });

    return [...players.values()].sort((a, b) => (b.seasons.length - a.seasons.length)
        || a.name.localeCompare(b.name));
}

/**
 * A player's career figure in one column. A rate is rebuilt from the summed components and never
 * summed itself.
 *
 * @param {{totals: Object<string, number>}} row A career row.
 * @param {string|number} statId The column's stat id.
 * @param {Array<{out: (string|number), num: string[], den: string[], scale: number, add: string[]}>} rateSpecs How each rate is built.
 * @returns {?number} The figure, or null when the row has none.
 */
export function careerValue(row, statId, rateSpecs) {
    const spec = (rateSpecs || []).find(s => String(s.out) === String(statId));
    if (!spec) {
        const v = row.totals[statId];
        return v === undefined ? null : v;
    }
    // A rate built by adding other rates, such as OPS from OBP and SLG. Each part is derived first.
    if (spec.add) {
        const parts = spec.add.map(id => careerValue(row, id, rateSpecs));
        return parts.some(p => p === null) ? null : parts.reduce((a, b) => a + b, 0);
    }
    return careerRate(row.totals, { numerator: spec.num, denominator: spec.den, scale: spec.scale });
}

/**
 * Sorts the career table by one column. A blank is not a small number: blanks sort last in either
 * direction. Equal values fall back to the name.
 *
 * @param {object[]} rows The career rows.
 * @param {{key: string, dir: ('asc'|'desc'), rateSpecs: object[]}} spec The column, 'name', 'seasons' or a stat id, and the direction.
 * @returns {object[]} A new sorted list. With no column, a copy in the order given.
 */
export function sortCareers(rows, spec) {
    const list = [...(rows || [])];
    if (!spec || !spec.key) return list;
    const sign = spec.dir === 'asc' ? 1 : -1;
    const valueOf = (row) => {
        if (spec.key === 'name') return row.name;
        if (spec.key === 'seasons') return row.seasons.length;
        return careerValue(row, spec.key, spec.rateSpecs);
    };
    return list.sort((a, b) => {
        const va = valueOf(a);
        const vb = valueOf(b);
        const blankA = va === null || va === undefined || va === '';
        const blankB = vb === null || vb === undefined || vb === '';
        if (blankA && blankB) return a.name.localeCompare(b.name);
        if (blankA) return 1;
        if (blankB) return -1;
        if (typeof va === 'string' || typeof vb === 'string') {
            return sign * String(va).localeCompare(String(vb));
        }
        if (va === vb) return a.name.localeCompare(b.name);
        return sign * (va < vb ? -1 : 1);
    });
}

// ==== Pane arithmetic ====

/**
 * The least height of a row in the categories table, in pixels. The row height is a budget
 * divided by the count of rows and held between two limits, so no element is measured.
 *
 * @type {number}
 */
export const CATEGORY_ROW_MIN = 20;
/**
 * The most height of a row in the categories table, in pixels.
 *
 * @type {number}
 */
export const CATEGORY_ROW_MAX = 34;
/**
 * The height the categories table's rows share, in pixels. Too small and the rows stop growing
 * sooner; too large and the limit catches it.
 *
 * @type {number}
 */
export const CATEGORY_ROWS_BUDGET = 320;

/**
 * The row height for the categories table.
 *
 * @param {number} seasonCount How many rows there are.
 * @param {number} [budget=CATEGORY_ROWS_BUDGET] The height to share.
 * @returns {number} The height in pixels, between the least and the most.
 */
export function categoryRowHeight(seasonCount, budget = CATEGORY_ROWS_BUDGET) {
    const n = Math.max(1, Math.floor(seasonCount) || 1);
    const share = Math.floor(budget / n);
    return Math.min(CATEGORY_ROW_MAX, Math.max(CATEGORY_ROW_MIN, share));
}

/**
 * Everything the rivalry card says about one pair of franchises, from payloads already held.
 * Unlike headToHead it keeps the meetings, since a streak, a run and a last meeting are questions
 * about their order.
 *
 * The record and the season lines are the regular season's. The streak, the longest run and the
 * last meeting read every meeting, playoffs included.
 *
 * @param {LeagueSeason[]} seasons The seasons.
 * @param {Object<number, object>} payloadsByYear Each season's league payload, by year.
 * @param {string} aKey The franchise the card is read from.
 * @param {string} bKey The opponent.
 * @returns {{meetings: Array<{year: number, period: number, playoff: boolean, result: ('a'|'b'|'tie')}>, total: {w: number, l: number, t: number}, seasons: Array<{year: number, w: number, l: number, t: number}>, streak: ?{side: string, count: number}, longest: ?{side: string, count: number, meetings: object[]}, playoff: {total: number, aWins: number, bWins: number, ties: number}, last: ?object}}
 *   The same shape with nothing in it when the two never met.
 */
export function rivalryDetail(seasons, payloadsByYear, aKey, bKey) {
    const empty = {
        meetings: [], total: { w: 0, l: 0, t: 0 }, seasons: [], streak: null, longest: null,
        playoff: { total: 0, aWins: 0, bWins: 0, ties: 0 }, last: null
    };
    if (!aKey || !bKey || aKey === bKey) return empty;

    const meetings = [];
    [...(seasons || [])].filter(Boolean).sort((x, y) => x.year - y.year).forEach(season => {
        if (!season.countsTowardRecords) return;
        const payload = payloadsByYear && payloadsByYear[season.year];
        if (!payload || !Array.isArray(payload.schedule)) return;
        const keyOfTeam = new Map(season.franchises.map(f => [f.teamId, f.key]));
        // Sorted by matchup period, since the last meeting and a run are claims about order and the schedule's own order is not promised.
        const games = payload.schedule
            .filter(game => {
                const home = game.home && keyOfTeam.get(game.home.teamId);
                const away = game.away && keyOfTeam.get(game.away.teamId);
                if (!home || !away) return false;
                return (home === aKey && away === bKey) || (home === bKey && away === aKey);
            })
            .sort((g, h) => (g.matchupPeriodId || 0) - (h.matchupPeriodId || 0));
        games.forEach(game => {
            if (!game.winner || game.winner === 'UNDECIDED') return;
            const homeKey = keyOfTeam.get(game.home.teamId);
            let result = 'tie';
            if (game.winner !== 'TIE') {
                const winnerKey = game.winner === 'HOME' ? homeKey : keyOfTeam.get(game.away.teamId);
                result = winnerKey === aKey ? 'a' : 'b';
            }
            meetings.push({
                year: season.year,
                period: game.matchupPeriodId || 0,
                playoff: isPostseasonGame(game),
                result
            });
        });
    });
    if (!meetings.length) return empty;

    // The record is the regular season, on the basis headToHead uses, so the card agrees with the row that opened it and with the standings. Postseason meetings are counted apart.
    const total = { w: 0, l: 0, t: 0 };
    const byYear = new Map();
    const playoff = { total: 0, aWins: 0, bWins: 0, ties: 0 };
    meetings.forEach(m => {
        if (m.playoff) {
            playoff.total += 1;
            if (m.result === 'a') playoff.aWins += 1; else if (m.result === 'b') playoff.bWins += 1; else playoff.ties += 1;
            return;
        }
        if (m.result === 'a') total.w += 1; else if (m.result === 'b') total.l += 1; else total.t += 1;
        if (!byYear.has(m.year)) byYear.set(m.year, { year: m.year, w: 0, l: 0, t: 0 });
        const s = byYear.get(m.year);
        if (m.result === 'a') s.w += 1; else if (m.result === 'b') s.l += 1; else s.t += 1;
    });

    // A tie ends a streak. The streak and the longest run read every meeting, playoffs included, as the last meeting does. The record and the season lines stay on the regular season, so a run can be longer than the record's wins; the playoff count on the same card accounts for it.
    let streak = null;
    for (let i = meetings.length - 1; i >= 0; i--) {
        const r = meetings[i].result;
        if (r === 'tie') break;
        if (!streak) streak = { side: r, count: 1 };
        else if (streak.side === r) streak.count += 1;
        else break;
    }

    // The run carries every meeting in it, each marked when it was a playoff game, so the card can name the meetings and not a range.
    let longest = null;
    let run = null;
    meetings.forEach(m => {
        if (m.result === 'tie') { run = null; return; }
        const at = { year: m.year, period: m.period, playoff: m.playoff };
        run = (run && run.side === m.result)
            ? { side: run.side, count: run.count + 1, meetings: [...run.meetings, at] }
            : { side: m.result, count: 1, meetings: [at] };
        // Strictly greater, so the earliest run of a shared best length is the one reported.
        if (!longest || run.count > longest.count) longest = { side: run.side, count: run.count, meetings: [...run.meetings] };
    });

    return {
        meetings,
        total,
        seasons: [...byYear.values()].sort((x, y) => x.year - y.year),
        streak,
        longest,
        playoff,
        // The last meeting reads every meeting, playoffs included, since it is a fact about recency.
        last: meetings[meetings.length - 1] || null
    };
}

// The split between the list and the card: even while the list is short, and wider for the list once it is long. Worked out from the opponent count against constants, never from what was rendered.
const RIVALRY_SPLIT_EVEN_MAX = 8;
const RIVALRY_SPLIT_HEAVY_MIN = 16;

/**
 * The share of the rivalry pane's width the list takes.
 *
 * @param {number} opponentCount How many opponents the list holds.
 * @returns {number} From 0.5 for a short list to 0.6 for a long one.
 */
export function rivalrySplit(opponentCount) {
    const n = Math.max(1, Math.floor(opponentCount) || 1);
    if (n <= RIVALRY_SPLIT_EVEN_MAX) return 0.5;
    if (n >= RIVALRY_SPLIT_HEAVY_MIN) return 0.6;
    const span = RIVALRY_SPLIT_HEAVY_MIN - RIVALRY_SPLIT_EVEN_MAX;
    return 0.5 + ((n - RIVALRY_SPLIT_EVEN_MAX) / span) * 0.1;
}

/**
 * The rivalry card's lower sections, in display order. Every league gets all of them, and a card
 * too tall for its pane scrolls inside its own frame.
 *
 * @type {string[]}
 */
export const RIVALRY_CARD_SECTIONS = ['longest', 'playoff', 'titles'];

/**
 * Names the meetings of a run. The season is restated only where the year changes, and a playoff
 * meeting is marked: 'Season 2026 Matchup 10', 'Season 2026 Matchup 10 and 20', 'Season 2023
 * Matchup 20, Season 2024 Matchup 2, and 5'.
 *
 * @param {{meetings: Array<{year: number, period: number, playoff: boolean}>}} run A run from rivalryDetail.
 * @returns {string} The text, empty for no run.
 */
export function runSpanText(run) {
    const meetings = (run && run.meetings) || [];
    if (!meetings.length) return '';
    let lastYear = null;
    const parts = meetings.map(m => {
        const where = m.year === lastYear ? `${m.period}` : `Season ${m.year} Matchup ${m.period}`;
        lastYear = m.year;
        return m.playoff ? `${where} Playoffs` : where;
    });
    if (parts.length === 1) return parts[0];
    // Three or more take the serial comma. Two take none.
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * Where the reader's own franchise sits in a list, so League History opens on it.
 *
 * @param {Franchise[]} franchises The franchises.
 * @param {string} swid The reader's ESPN id.
 * @returns {number} The index, or 0 when nothing matches.
 */
export function defaultFranchiseIndex(franchises, swid) {
    const me = normSwid(swid);
    if (!me) return 0;
    const i = (franchises || []).findIndex(f => f && normSwid(f.key) === me);
    return i >= 0 ? i : 0;
}

/**
 * The sentence saying which seasons a record covers. Empty when every season counts.
 *
 * @param {number[]} countedYears The years that count toward records.
 * @param {number[]} allYears Every year held.
 * @returns {string} The sentence, or an empty string.
 */
export function coverageSentence(countedYears, allYears) {
    const counted = [...new Set(countedYears || [])].sort((a, b) => a - b);
    const all = [...new Set(allYears || [])].sort((a, b) => a - b);
    const others = all.filter(y => !counted.includes(y));
    if (!counted.length || !others.length) return '';
    return `Only applicable for head to head seasons (${counted.join(', ')}).`;
}


/**
 * Splits a team's name into a pennant's two lines: the last word is the nickname, and whatever
 * comes before it runs above.
 *
 * @param {string} name The team's name.
 * @returns {{top: string, nick: string}} A one-word name has an empty top line.
 */
export function pennantLines(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { top: '', nick: '' };
    return { top: words.slice(0, -1).join(' '), nick: words[words.length - 1] };
}


// One finished season reduced to the card a pennant opens. The blowout and the closest game come from matchupExtremes, which the weekly recap calls too, so the two cannot disagree. This file imports nothing, so the readers of a matchup's tally and points are passed in.

/**
 * The widest and the narrowest decided margin among a set of matchups, and the tied ones.
 *
 * A tie is the closest matchup, so the closest is null whenever there are ties. It is also null
 * when it would be the same game as the blowout. Ties are found by ESPN's own flag and not by a
 * zero margin.
 *
 * @param {MatchupRow[]} rows The matchups.
 * @returns {{blowout: ?MatchupRow, closest: ?MatchupRow, ties: MatchupRow[]}} The three readings.
 */
export function matchupExtremes(rows) {
    const all = (rows || []).filter(r => r && r.decided);
    const ties = all.filter(r => r.tie);
    const decided = all.filter(r => !r.tie);
    if (!decided.length) return { blowout: null, closest: null, ties };
    const blowout = decided.reduce((a, b) => (b.margin > a.margin ? b : a));
    let closest = decided.length > 1 ? decided.reduce((a, b) => (b.margin < a.margin ? b : a)) : null;
    if (closest === blowout || ties.length) closest = null;
    return { blowout, closest, ties };
}

// The season's matchups as neutral rows, one per game, both sides valued by the caller's readers. A roto season has no schedule and gives none.
function seasonRows(payload, keyOf, opts) {
    const format = seasonFormat(payload);
    if (format === 'roto') return [];
    const points = format === 'points';
    const tallyOf = opts && opts.tallyOf;
    const pointsOf = opts && opts.pointsOf;
    const rows = [];
    (payload.schedule || []).forEach(game => {
        if (!game || !game.home || !game.away) return;
        const side = (which) => {
            const s = game[which];
            const tally = points ? null : (tallyOf ? tallyOf(s) : null);
            const wins = tally && Number.isFinite(tally.wins) ? tally.wins : 0;
            const ties = tally && Number.isFinite(tally.ties) ? tally.ties : 0;
            return {
                key: keyOf(s.teamId),
                teamId: s.teamId,
                // A category week is valued by category wins, half for a tie. A points week is the points.
                value: points ? (pointsOf ? pointsOf(s) : 0) : wins + ties * 0.5,
                catWins: points ? null : wins
            };
        };
        const home = side('home'), away = side('away');
        const decided = !!game.winner && game.winner !== 'UNDECIDED';
        rows.push({
            week: game.matchupPeriodId,
            postseason: isPostseasonGame(game),
            home, away, decided,
            tie: game.winner === 'TIE',
            winner: game.winner === 'HOME' ? home : (game.winner === 'AWAY' ? away : null),
            loser: game.winner === 'HOME' ? away : (game.winner === 'AWAY' ? home : null),
            margin: Math.abs(home.value - away.value)
        });
    });
    return rows;
}

// The longest run of consecutive wins by one franchise, in matchup order. A tie or an undecided game ends the run of both sides. A run of one is not reported.
function longestStreakOf(rows) {
    const byKey = new Map();
    [...rows].sort((a, b) => a.week - b.week).forEach(r => {
        if (!r.decided || r.tie || !r.winner || !r.loser) {
            [r.home, r.away].forEach(side => {
                const s = side && side.key ? byKey.get(side.key) : null;
                if (s) { s.run = 0; s.from = null; }
            });
            return;
        }
        [[r.winner.key, true], [r.loser.key, false]].forEach(([key, won]) => {
            if (!key) return;
            const s = byKey.get(key) || { run: 0, best: 0, from: null, to: null, bestFrom: null, bestTo: null };
            if (won) {
                s.run += 1;
                if (s.run === 1) s.from = r.week;
                s.to = r.week;
                if (s.run > s.best) { s.best = s.run; s.bestFrom = s.from; s.bestTo = s.to; }
            } else {
                s.run = 0; s.from = null;
            }
            byKey.set(key, s);
        });
    });
    let best = null;
    byKey.forEach((s, key) => {
        if (s.best > 1 && (!best || s.best > best.value)) {
            best = { key, value: s.best, when: `M${s.bestFrom}-M${s.bestTo}` };
        }
    });
    return best;
}

/**
 * The order a season's teams are in, and the basis it was ordered on.
 *
 * A roto season is ordered by its points. A season with a final rank on every team keeps that
 * rank, which is a playoff finish and not a table. Any other season is ordered by record: ESPN's
 * own winning percentage, then points for, then playoff seed, then team id.
 *
 * @param {object} payload The season's league payload.
 * @returns {?{basis: ('points'|'finish'|'record'), rows: Array<{teamId: number, place: number, percentage: ?number, pointsFor: ?number, points: ?number, seed: ?number, finish: ?number}>}}
 *   The rows in order with distinct places from one. Null for a payload with no teams list.
 */
export function seasonOrder(payload) {
    if (!payload || !Array.isArray(payload.teams)) return null;
    const format = seasonFormat(payload);
    const num = (v) => (Number.isFinite(v) ? v : null);

    const rows = payload.teams.map(team => {
        const o = (team.record && team.record.overall) || {};
        const games = (o.wins || 0) + (o.losses || 0) + (o.ties || 0);
        return {
            teamId: team.id,
            place: 0,
            // A team that has played nothing has no percentage. Null, not zero, since a zero would seat it among the teams that have lost.
            percentage: Number.isFinite(o.percentage)
                ? o.percentage
                : (games > 0 ? ((o.wins || 0) + (o.ties || 0) * 0.5) / games : null),
            pointsFor: num(o.pointsFor),
            points: num(team.points),
            seed: Number.isFinite(team.playoffSeed) && team.playoffSeed > 0 ? team.playoffSeed : null,
            finish: Number.isFinite(team.rankCalculatedFinal) && team.rankCalculatedFinal > 0
                ? team.rankCalculatedFinal
                : null
        };
    });

    const ranked = format === 'roto'
        ? 'points'
        : (rows.length && rows.every(r => r.finish !== null) ? 'finish' : 'record');

    // Descending on a figure that may be null, with null last.
    const desc = (a, b) => {
        if (a === b) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return b - a;
    };
    // Ascending has its own comparison. Swapping the arguments of the descending one would swap the null rule too and seat an unseeded team first.
    const asc = (a, b) => {
        if (a === b) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b;
    };
    rows.sort((a, b) => {
        if (ranked === 'points') return desc(a.points, b.points) || a.teamId - b.teamId;
        if (ranked === 'finish') return a.finish - b.finish;
        return desc(a.percentage, b.percentage)
            || desc(a.pointsFor, b.pointsFor)
            || asc(a.seed, b.seed)
            || a.teamId - b.teamId;
    });
    rows.forEach((r, i) => { r.place = i + 1; });
    return { basis: ranked, rows };
}

/**
 * One season as its card reads it: the podium, the champion's path, the facts and the standings.
 *
 * A roto season answers less. It has no schedule, so the path and every fact built on matchups is
 * null. Figures a season cannot answer are null and never zero.
 *
 * @param {object} payload The season's league payload.
 * @param {Franchise[]} franchises The franchises, for each key's current name.
 * @param {object} [opts]
 * @param {function(object): {wins: number, ties: number}} [opts.tallyOf] Reads one side's category tally from a schedule entry.
 * @param {function(object): number} [opts.pointsOf] Reads one side's points from a schedule entry.
 * @returns {?{year: ?number, format: string, teams: number, champion: ?string, championName: ?string, podium: object[], path: ?object[], facts: {mostCatWins: ?SeasonFact, bestWeek: ?SeasonFact, longestStreak: ?SeasonFact, biggestBlowout: ?SeasonFact, closest: ?SeasonFact, ties: ?{count: number, games: object[]}}, standings: object[], pointsFacts: ?object, standingsBasis: ?string}}
 *   Null for a payload with no teams.
 */
export function seasonSummary(payload, franchises, opts = {}) {
    if (!payload || !Array.isArray(payload.teams) || !payload.teams.length) return null;
    const format = seasonFormat(payload);
    const roto = format === 'roto';
    const points = format === 'points';
    const byId = new Map(payload.teams.map(t => [t.id, t]));
    const keyOf = (teamId) => {
        const t = byId.get(teamId);
        return t ? franchiseKeyOf(t) : null;
    };
    const nameByKey = new Map((franchises || []).map(f => [f.key, f.name]));
    const nameOf = (key, teamId) => nameByKey.get(key)
        || (byId.has(teamId) ? teamDisplayName(byId.get(teamId)) : null);

    const rows = seasonRows(payload, keyOf, opts);
    const championKey = championKeyOf(payload);

    // Category wins per franchise over the season's rows. The table's order is seasonOrder's, read and not derived again, so the table and the podium, which is its first three rows, cannot disagree on who won.
    const catWinsByKey = new Map();
    rows.forEach(r => {
        [r.home, r.away].forEach(s => {
            if (!s.key || s.catWins === null) return;
            catWinsByKey.set(s.key, (catWinsByKey.get(s.key) || 0) + s.catWins);
        });
    });
    const order = seasonOrder(payload);

    // A season nobody has played has no order: no place, no podium and no basis, and a category season's wins read null. Played means any one of three things: a decided matchup in the schedule, a game in any team's record, or a final rank on every team. A roto season is never unplayed in this sense, since it is ordered by its points.
    const anyDecided = rows.some(r => r.decided);
    const anyRecord = payload.teams.some(t => {
        const o = (t && t.record && t.record.overall) || {};
        return (Number(o.wins) || 0) + (Number(o.losses) || 0) + (Number(o.ties) || 0) > 0;
    });
    const unplayed = !roto && !anyDecided && !anyRecord && !(order && order.basis === 'finish');
    const placeById = new Map((unplayed || !order ? [] : order.rows).map(r => [r.teamId, r.place]));
    const standings = payload.teams.map(t => {
        const key = franchiseKeyOf(t);
        const o = (t.record && t.record.overall) || {};
        return {
            place: placeById.get(t.id) ?? null,
            key,
            name: nameOf(key, t.id),
            record: roto ? null : recordText(o.wins || 0, o.losses || 0, o.ties || 0),
            catWins: (roto || points || unplayed) ? null : (catWinsByKey.get(key) ?? null),
            finish: Number.isFinite(t.rankCalculatedFinal) && t.rankCalculatedFinal > 0
                ? t.rankCalculatedFinal : null,
            seed: Number.isFinite(t.playoffSeed) && t.playoffSeed > 0 ? t.playoffSeed : null,
            points: (points || roto) && Number.isFinite(t.points) ? t.points : null,
            // Points scored and given up, in a points season only. A category season files zero on every team, which is no measurement, so it reads null. An unplayed season reads null for the same reason.
            pointsFor: points && !unplayed && Number.isFinite(o.pointsFor) ? o.pointsFor : null,
            pointsAgainst: points && !unplayed && Number.isFinite(o.pointsAgainst) ? o.pointsAgainst : null,
            wins: roto ? null : (o.wins || 0)
        };
    }).sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity));

    // The champion is championKeyOf's and never the top of this table. The champion's row says Champion wherever it sits. The other two rows take the beaten finalist's words only when the champion is at the top, and their place in the table otherwise.
    const BEATEN = ['Champion', 'Runner-up', 'Third'];
    const ORDINAL = ['First', 'Second', 'Third'];
    const top = standings[0];
    const championAtTop = !!(championKey && top && top.key === championKey);
    const podium = (unplayed ? [] : standings.slice(0, 3)).map((s, i) => ({
        key: s.key,
        name: s.name,
        record: s.record,
        seed: s.seed,
        note: (s.key && s.key === championKey) ? 'Champion' : (championAtTop ? BEATEN[i] : ORDINAL[i])
    }));

    // The champion's postseason games in order. Null for a roto season, which has no bracket, and for a champion the payload cannot name.
    const path = (roto || !championKey) ? null : rows
        .filter(r => r.postseason && (r.home.key === championKey || r.away.key === championKey))
        .sort((a, b) => a.week - b.week)
        .map(r => {
            const mine = r.home.key === championKey ? r.home : r.away;
            const theirs = mine === r.home ? r.away : r.home;
            const fmt = (v) => (points ? Number(v).toFixed(1) : String(v));
            return {
                round: r.week,
                opponentKey: theirs.key,
                opponentName: nameOf(theirs.key, theirs.teamId),
                score: `${fmt(mine.value)}-${fmt(theirs.value)}`,
                won: r.decided && !r.tie ? r.winner === mine : null
            };
        });

    // Every one of these is null, not zero, on a season whose schedule cannot answer it. A zero margin would read as a tie that never happened.
    const { blowout, closest, ties } = matchupExtremes(rows);
    const gameFact = (r) => (r ? {
        key: r.winner ? r.winner.key : null,
        against: r.loser ? r.loser.key : null,
        value: r.margin,
        when: `M${r.week}`
    } : null);

    // A best needs something to have happened. Both of these are a maximum, and a maximum over a season nobody has played is a zero with a name on it, so neither is reported until one matchup is decided.

    let bestWeek = null;
    if (anyDecided) rows.forEach(r => {
        [r.home, r.away].forEach(s => {
            if (!s.key || !Number.isFinite(s.value)) return;
            if (!bestWeek || s.value > bestWeek.value) bestWeek = { key: s.key, value: s.value, when: `M${r.week}` };
        });
    });

    let mostCatWins = null;
    if (anyDecided) catWinsByKey.forEach((value, key) => {
        if (!mostCatWins || value > mostCatWins.value) mostCatWins = { key, value, when: null };
    });

    return {
        year: payload.seasonId ?? null,
        format,
        teams: payload.teams.length,
        champion: championKey,
        championName: championKey ? (nameByKey.get(championKey) || null) : null,
        podium,
        path: path && path.length ? path : (roto ? null : path),
        facts: {
            // A season total, so it has no single matchup to point at.
            mostCatWins: points ? null : mostCatWins,
            bestWeek,
            longestStreak: rows.length ? longestStreakOf(rows) : null,
            biggestBlowout: gameFact(blowout),
            closest: gameFact(closest),
            // The ties, which are the season's closest matchups: how many and between whom. Null where there were none. Keys, not names, since the caller holds the names.
            ties: ties.length ? {
                count: ties.length,
                games: ties.map(r => ({ keys: [r.home.key, r.away.key], when: `M${r.week}` }))
            } : null
        },
        standings,
        // A points season's own facts, null in the other two formats and with no matchup decided. Beside the facts and not inside them, so a reader of the facts meets the same six as before.
        pointsFacts: points ? seasonPointsFacts(rows) : null,
        // Which question the order answered: 'finish' is where a team ended once the playoffs were played, 'record' is where it stands so far, and 'points' is a roto total.
        standingsBasis: (unplayed || !order) ? null : order.basis
    };
}

// ==== The season box, per format ====

const scoredCategoriesOf = (payload) => ((payload && payload.settings && payload.settings.scoringSettings
    && payload.settings.scoringSettings.scoringItems) || [])
    .filter(i => i && i.statId !== undefined && i.statId !== null)
    .map(i => ({ statId: String(i.statId), inverse: !!i.isReverseItem }));

// A team's season figure in one category, or null. For a rate it is the season's rate as ESPN computed it, never an average of weeks.
const seasonFigureOf = (team, statId) => {
    const v = team && team.valuesByStat ? team.valuesByStat[statId] : undefined;
    return Number.isFinite(v) ? v : null;
};

/**
 * Who led the league in each scored category over the season, and how many each team led. A lead
 * held alone and a shared one are counted apart.
 *
 * @param {object} payload The season's league payload.
 * @returns {?{categories: Array<{statId: string, inverse: boolean, value: ?number, leaders: Array<{key: ?string, teamId: number}>, missing: number}>, byTeam: Array<{key: ?string, teamId: number, led: number, shared: number}>}}
 *   Null for a points season and for a season where no team has posted a figure.
 */
export function seasonCategoryLeaders(payload) {
    if (!payload || !Array.isArray(payload.teams) || !payload.teams.length) return null;
    if (seasonFormat(payload) === 'points') return null;
    const cats = scoredCategoriesOf(payload);
    if (!cats.length) return null;
    const anything = payload.teams.some(t => cats.some(c => (seasonFigureOf(t, c.statId) || 0) !== 0));
    if (!anything) return null;

    const tally = new Map(payload.teams.map(t => [t.id, { led: 0, shared: 0 }]));
    const categories = cats.map(c => {
        const have = payload.teams
            .map(t => ({ teamId: t.id, key: franchiseKeyOf(t), value: seasonFigureOf(t, c.statId) }))
            .filter(r => r.value !== null);
        if (!have.length) return { statId: c.statId, inverse: c.inverse, value: null, leaders: [], missing: payload.teams.length };
        const best = have.reduce((a, r) => (c.inverse ? Math.min(a, r.value) : Math.max(a, r.value)), have[0].value);
        const leaders = have.filter(r => r.value === best).map(r => ({ key: r.key, teamId: r.teamId }));
        leaders.forEach(l => { tally.get(l.teamId)[leaders.length === 1 ? 'led' : 'shared'] += 1; });
        return { statId: c.statId, inverse: c.inverse, value: best, leaders, missing: payload.teams.length - have.length };
    });
    return {
        categories,
        byTeam: payload.teams.map(t => ({ key: franchiseKeyOf(t), teamId: t.id, ...tally.get(t.id) }))
    };
}

/**
 * A points season's facts: the lowest score, the highest score that still lost, each team's
 * average, and who had the most scored against them.
 *
 * The two single-game facts read every decided matchup, playoffs included. The average and the
 * points against are the regular season's, as ESPN's own season line is.
 *
 * @param {MatchupRow[]} rows The season's matchups.
 * @returns {?{lowestWeek: ?SeasonFact, highestLoss: ?SeasonFact, averages: Array<{key: string, games: number, average: number}>, mostAgainst: ?{key: string, value: number}}}
 *   Null until one matchup is decided.
 */
export function seasonPointsFacts(rows) {
    const decided = (rows || []).filter(r => r && r.decided && r.home && r.away);
    if (!decided.length) return null;
    let lowestWeek = null, highestLoss = null;
    const line = new Map();
    decided.forEach(r => {
        [[r.home, r.away], [r.away, r.home]].forEach(([mine, theirs]) => {
            if (!mine.key || !Number.isFinite(mine.value)) return;
            if (!lowestWeek || mine.value < lowestWeek.value) lowestWeek = { key: mine.key, value: mine.value, when: `M${r.week}` };
            if (r.postseason) return;
            if (!line.has(mine.key)) line.set(mine.key, { key: mine.key, games: 0, pointsFor: 0, pointsAgainst: 0 });
            const l = line.get(mine.key);
            l.games += 1;
            l.pointsFor += mine.value;
            if (Number.isFinite(theirs.value)) l.pointsAgainst += theirs.value;
        });
        if (!r.tie && r.loser && r.loser.key && Number.isFinite(r.loser.value)
            && (!highestLoss || r.loser.value > highestLoss.value)) {
            highestLoss = { key: r.loser.key, value: r.loser.value, when: `M${r.week}` };
        }
    });
    const lines = [...line.values()];
    const averages = lines
        .map(l => ({ key: l.key, games: l.games, average: l.pointsFor / l.games }))
        .sort((a, b) => b.average - a.average || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)));
    const against = lines.length ? lines.reduce((a, l) => (l.pointsAgainst > a.pointsAgainst ? l : a)) : null;
    return {
        lowestWeek,
        highestLoss,
        averages,
        mostAgainst: against ? { key: against.key, value: against.pointsAgainst } : null
    };
}

/**
 * A roto season as a table: each team's figure, roto points and place in every scored category,
 * the categories it won alone, its total, and the gap to the row below.
 *
 * The points are ESPN's where ESPN filed them. The reader passed in rebuilds a cell ESPN left
 * empty.
 *
 * @param {object} payload The season's league payload.
 * @param {object} [opts]
 * @param {function(Array<{id: number, value: ?number}>, boolean): Map<number, number>} [opts.rotoPointsOf] Roto points for one category's figures; rank-engine.js's rotoPointsForCategory.
 * @returns {?{categories: Array<{statId: string, inverse: boolean}>, pointsBasis: ?('espn'|'rebuilt'|'mixed'), rows: Array<{key: ?string, teamId: number, place: ?number, total: ?number, marginToNext: ?number, won: number, categories: Object<string, {value: ?number, points: ?number, place: ?number}>}>}}
 *   The rows by total, level totals sharing a place. Null for a season that is not roto.
 */
export function rotoSeasonTable(payload, { rotoPointsOf } = {}) {
    if (!payload || !Array.isArray(payload.teams) || !payload.teams.length) return null;
    if (seasonFormat(payload) !== 'roto') return null;
    const cats = scoredCategoriesOf(payload);
    if (!cats.length) return null;

    let fromEspn = 0, rebuiltCells = 0;
    const cells = new Map(payload.teams.map(t => [t.id, {}]));
    cats.forEach(c => {
        const entries = payload.teams.map(t => ({ id: t.id, value: seasonFigureOf(t, c.statId) }));
        const rebuilt = typeof rotoPointsOf === 'function' ? rotoPointsOf(entries, c.inverse) : null;
        payload.teams.forEach(t => {
            const value = seasonFigureOf(t, c.statId);
            const filed = t.pointsByStat ? t.pointsByStat[c.statId] : undefined;
            let pts = null;
            if (Number.isFinite(filed)) { pts = filed; fromEspn += 1; }
            else if (rebuilt && Number.isFinite(rebuilt.get(t.id))) { pts = rebuilt.get(t.id); rebuiltCells += 1; }
            const better = value === null ? null : entries.filter(e => e.value !== null
                && (c.inverse ? e.value < value : e.value > value)).length;
            cells.get(t.id)[c.statId] = { value, points: pts, place: better === null ? null : better + 1 };
        });
    });

    const rows = payload.teams.map(t => {
        const mine = cells.get(t.id);
        const won = cats.filter(c => mine[c.statId].place === 1
            && payload.teams.every(o => o.id === t.id || cells.get(o.id)[c.statId].place !== 1)).length;
        const every = cats.map(c => mine[c.statId].points);
        const total = Number.isFinite(t.points)
            ? t.points
            : (every.every(v => v !== null) ? every.reduce((a, v) => a + v, 0) : null);
        return { key: franchiseKeyOf(t), teamId: t.id, place: null, total, marginToNext: null, won, categories: mine };
    }).sort((a, b) => {
        if (a.total === b.total) return a.teamId - b.teamId;
        if (a.total === null) return 1;
        if (b.total === null) return -1;
        return b.total - a.total;
    });
    rows.forEach((r, i) => {
        if (r.total === null) return;
        r.place = 1 + rows.filter(o => o.total !== null && o.total > r.total).length;
        const next = rows[i + 1];
        r.marginToNext = next && next.total !== null ? r.total - next.total : null;
    });
    return {
        categories: cats,
        pointsBasis: !fromEspn && !rebuiltCells ? null : (!rebuiltCells ? 'espn' : (!fromEspn ? 'rebuilt' : 'mixed')),
        rows
    };
}
