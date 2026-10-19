/**
 * The two sides of the matchup being played, in the shape matchup-odds.js takes: per scored
 * category what is on the board, what the rest of the matchup is expected to bring, and the
 * spread of that remainder.
 *
 * The mean is ESPN's own projected line for each player, as a line per game, over the games the
 * player is expected to appear in. The spread is the player's own, off the day lines of the
 * season so far. A rate is rebuilt from its components and is left out altogether when a side
 * has nothing to divide by. The rule handed on names the categories that are a contest and how
 * much the sport's categories move together.
 *
 * Every input is an argument: the board, the rosters, the schedule's games and the day lines are
 * read by the caller from what is already fetched.
 *
 * Pure. No DOM, no application state, no storage, no network and no clock.
 *
 * Contract: tests/fixtures/matchup-sides.md
 * Tests: tests/matchup-sides.test.html
 * @module matchup-sides
 */
/**
 * One player of a side.
 *
 * @typedef {object} SidePlayer
 * @property {number|string} playerId The player's id.
 * @property {number} lineupSlotId The slot the player sits in today.
 * @property {number} proTeamId The player's club.
 * @property {string} group The seats the player competes for, in the caller's own word.
 * @property {?Object<string, number>} projected ESPN's projected stats row for the player.
 * @property {?(string|number)} gamesId Which id of that row is its games.
 * @property {?Object<string, number>} [season] The player's own season line so far, read by the same games id.
 * @property {?number} [pointsPerGame] In a points league, the row's own points a game.
 * @property {?number} share The part of the club's games the player appears in, at most 1; null when nobody can say.
 * @property {?number} [listed] A starting pitcher's listed starts left, which replaces the share when present.
 * @property {Array<Object<string, number>>} [dayLines] One stat line per club game so far, a missed game empty.
 */
/**
 * One side as the caller hands it in.
 *
 * @typedef {object} SideInput
 * @property {Object<string, number>} [board] The matchup so far by stat id, rate components included.
 * @property {number} [points] In a points league, the side's total so far.
 * @property {SidePlayer[]} players The side's roster.
 */
/**
 * What the caller knows about the league and the days left.
 *
 * @typedef {object} SidesContext
 * @property {string} sport The sport key, read for rho alone.
 * @property {string} [scoring] 'points' for a points league; otherwise categories.
 * @property {Array<string|number>} [scoredStatIds] The scored categories, in the league's order.
 * @property {Array<string|number>} [inverseStatIds] The categories where lower wins.
 * @property {Array<{out: string, num: (string[]|undefined), den: (string[]|undefined), add: (string[]|undefined), scale: (number|undefined)}>} [rateSpecs] How each rate is built from its components.
 * @property {{rule: string, statId: *}} [tie] The league's matchup tie rule.
 * @property {number[]} periodsLeft The scoring periods whose games the board does not hold yet.
 * @property {Object<string, Object<string, number>>} clubGames Games by club id by scoring period.
 * @property {Object<string, number>} [seats] Starting seats by group. A group with no entry is not short of seats.
 * @property {Object<string, Array<string|number>>} [groupStatIds] The ids a group brings. An id listed under any group is brought only by the groups that list it.
 * @property {number[]} [outSlots] Slots that take no seat, the injured list.
 * @property {Object<string, Object<string, number>>} [poolVariance] The floor by group and stat id, from poolVariance.
 */
import { MATCHUP_RHO } from './matchup-odds.js';

const key = id => String(id);
const known = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num = v => (known(v) ? Number(v) : 0);

// ==== Rates from components ====

// A rate from summed components. A rate made of other rates is read through its parts. A rate with nothing to divide by has no value, which is null and never 0.
function rateOf(sums, spec, specs) {
    if (spec.add) {
        let total = 0;
        for (const part of spec.add) {
            const sub = specs.find(s => key(s.out) === key(part));
            const value = sub ? rateOf(sums, sub, specs) : null;
            if (value === null) return null;
            total += value;
        }
        return total;
    }
    const top = (spec.num || []).reduce((a, id) => a + num(sums[key(id)]), 0);
    const bottom = (spec.den || []).reduce((a, id) => a + num(sums[key(id)]), 0);
    return bottom ? (top / bottom) * (spec.scale || 1) : null;
}

// Every component id a rate reads, through its parts, each once.
function componentsOf(spec, specs) {
    const list = spec.add
        ? spec.add.flatMap(part => { const sub = specs.find(s => key(s.out) === key(part)); return sub ? componentsOf(sub, specs) : []; })
        : [...(spec.num || []), ...(spec.den || [])];
    return [...new Set(list.map(key))];
}

// The mean and the population variance of one stat over a player's day lines. A missed game is a line with nothing on it and counts as zero.
function momentsOver(dayLines, read) {
    const n = dayLines.length;
    if (!n) return { mean: 0, variance: 0 };
    let sum = 0;
    let squares = 0;
    dayLines.forEach(line => { const v = read(line || {}); sum += v; squares += v * v; });
    const mean = sum / n;
    return { mean, variance: Math.max(0, squares / n - mean * mean) };
}

// ==== The floor ====

/**
 * The floor for a player who has never varied in a stat: per group and stat, the mean of every
 * player's own variance a game, a player who never varied counted at zero. A player with no day
 * line at all has not been measured and is not in the mean.
 *
 * @param {Array<{group: string, dayLines: Array<Object<string, number>>}>} players The league's rostered players.
 * @param {Array<string|number>} statIds The stats to take the floor for. 'points' is read like any other.
 * @returns {Object<string, Object<string, number>>} The variance by group and stat id. A group with no measured player has no entry.
 */
export function poolVariance(players, statIds) {
    const ids = (statIds || []).map(key);
    const cells = {};
    (players || []).forEach(p => {
        const lines = (p && p.dayLines) || [];
        if (!p || !lines.length) return;
        const group = cells[p.group] || (cells[p.group] = { n: 0, sums: {} });
        group.n += 1;
        ids.forEach(id => { group.sums[id] = (group.sums[id] || 0) + momentsOver(lines, line => num(line[id])).variance; });
    });
    const out = {};
    Object.keys(cells).forEach(g => {
        out[g] = {};
        ids.forEach(id => { out[g][id] = cells[g].sums[id] / cells[g].n; });
    });
    return out;
}

// ==== One side ====

// The players of a side who can be placed, each with the seat games left. A player with no line or no share is named and takes no seat.
function placedPlayers(side, ctx, points) {
    const out = new Set((ctx.outSlots || []).map(Number));
    const noLine = [];
    const noShare = [];
    const players = [];
    ((side && side.players) || []).forEach(p => {
        if (!p || out.has(Number(p.lineupSlotId))) return;
        const games = p.projected && known(p.gamesId) ? num(p.projected[key(p.gamesId)]) : 0;
        const hasLine = points ? known(p.pointsPerGame) : games > 0;
        if (!hasLine) { noLine.push(p.playerId); return; }
        if (!known(p.listed) && !known(p.share)) { noShare.push(p.playerId); return; }
        players.push({ source: p, group: p.group, games, dayLines: p.dayLines || [], seatGames: 0 });
    });
    const seats = ctx.seats || {};
    (ctx.periodsLeft || []).forEach(period => {
        const playing = players
            .map(pl => ({ pl, count: num(((ctx.clubGames || {})[key(pl.source.proTeamId)] || {})[key(period)]) }))
            .filter(x => x.count > 0);
        const byGroup = {};
        playing.forEach(x => { byGroup[x.pl.group] = (byGroup[x.pl.group] || 0) + 1; });
        playing.forEach(x => {
            const limit = seats[x.pl.group];
            const share = known(limit) && byGroup[x.pl.group] > num(limit) ? num(limit) / byGroup[x.pl.group] : 1;
            x.pl.seatGames += share * x.count;
        });
    });
    players.forEach(pl => {
        const p = pl.source;
        pl.appearances = known(p.listed) ? num(p.listed) : Math.min(1, Math.max(0, num(p.share))) * pl.seatGames;
    });
    return { players, noLine, noShare };
}

// ==== The matchup ====

/**
 * The two sides of one matchup and the rule to fold them under, ready for matchupOdds.
 *
 * A player's line a game is the projected stat over the games of the same projected row, since
 * that row is sometimes the rest of the season and sometimes a whole season, and a stat over its
 * own games is a rate either way. Appearances are a pitcher's listed starts when published, and
 * otherwise the player's share of the club's games times the seat games left. Seat games share a
 * group's seats on a day when more of the group play than there are seats.
 *
 * The spread is each player's own variance a club game, off the day lines, times the seat games,
 * with the pool's variance in place of a zero. A rate is the rate of its finished components and
 * its spread the first-order one. A rate with nothing to divide by on either side is not a
 * contest and is left out of both sides and of the rule.
 *
 * @param {{mine: SideInput, theirs: SideInput}} [sides] The two sides.
 * @param {SidesContext} [ctx] The league and the days left.
 * @returns {?{mine: object, theirs: object, rule: object, leftOut: Array<{statId: string, reason: string, side: string}>, basis: object}}
 *   The sides by stat id, or for a points league one figure a side; the rule; what was left out and
 *   why; and what each side was built from. Null when a side is missing, the days left are not
 *   given, or no category is left to contest. In a points league a side whose spread nobody
 *   measured carries an sd of null, which is not zero. A stat a side brings that no projected row
 *   carries takes each player's own season rate a game and is named in that side's basis; with
 *   no season line either it is left out of both sides and the rule.
 */
export function matchupSides({ mine, theirs } = {}, ctx = {}) {
    if (!mine || !theirs || !Array.isArray(ctx.periodsLeft)) return null;
    const points = ctx.scoring === 'points';
    const specs = ctx.rateSpecs || [];
    const specOf = id => specs.find(s => key(s.out) === id) || null;
    const scored = (ctx.scoredStatIds || []).map(key);
    if (!points && !scored.length) return null;

    // Which ids a group brings. An id some group lists belongs to the groups that list it.
    const listedBy = new Map();
    Object.keys(ctx.groupStatIds || {}).forEach(group => {
        (ctx.groupStatIds[group] || []).forEach(id => {
            if (!listedBy.has(key(id))) listedBy.set(key(id), new Set());
            listedBy.get(key(id)).add(group);
        });
    });
    const brings = (group, id) => !listedBy.has(id) || listedBy.get(id).has(group);
    const floorOf = (group, id) => num(((ctx.poolVariance || {})[group] || {})[id]);
    const tracked = points ? [] : [...new Set(scored.flatMap(id => { const spec = specOf(id); return spec ? componentsOf(spec, specs) : [id]; }))];

    const build = side => {
        const { players, noLine, noShare } = placedPlayers(side, ctx, points);
        const basis = { players: players.length, seatGames: players.reduce((a, pl) => a + pl.seatGames, 0), noLine, noShare, floored: 0, unprojected: [], fallback: [] };

        if (points) {
            let expected = 0;
            let variance = 0;
            let measured = false;
            players.forEach(pl => {
                expected += num(pl.source.pointsPerGame) * pl.appearances;
                const own = momentsOver(pl.dayLines, line => num(line.points)).variance;
                const floor = floorOf(pl.group, 'points');
                if (pl.seatGames > 0 && (pl.dayLines.length || floor > 0)) measured = true;
                if (!(own > 0) && floor > 0 && pl.seatGames > 0) basis.floored += 1;
                variance += (own > 0 ? own : floor) * pl.seatGames;
            });
            // With games left and nobody measured, the spread is unknown, which is not zero.
            const sd = basis.seatGames > 0 && !measured ? null : Math.sqrt(variance);
            return { values: { current: num(side.points), expectedRemaining: expected, sd }, basis, missing: [] };
        }

        const board = side.board || {};
        const expected = {};
        const variance = {};
        // Which stats somebody brings, which a projected row carries, and which a season line does.
        const brought = new Set();
        const projectedFor = new Set();
        const seasonFor = new Set();
        const seasonRate = (pl, id) => {
            const season = pl.source.season || null;
            const games = season ? num(season[key(pl.source.gamesId)]) : 0;
            return games > 0 && known(season[id]) ? num(season[id]) / games : null;
        };
        players.forEach(pl => tracked.forEach(id => {
            if (!brings(pl.group, id)) return;
            brought.add(id);
            if (known(pl.source.projected[id])) projectedFor.add(id);
            if (seasonRate(pl, id) !== null) seasonFor.add(id);
        }));
        // A stat no row projects takes the player's own season rate a game, and is named. With no season line either there is no mean to give it, and it leaves the fold.
        const unprojected = tracked.filter(id => brought.has(id) && !projectedFor.has(id));
        const fallen = new Set(unprojected.filter(id => seasonFor.has(id)));
        const dead = new Set(unprojected.filter(id => !seasonFor.has(id)));
        basis.unprojected = unprojected;
        basis.fallback = [...fallen];
        players.forEach(pl => {
            pl.dayMean = {};
            tracked.forEach(id => {
                if (!brings(pl.group, id)) return;
                const own = momentsOver(pl.dayLines, line => num(line[id]));
                pl.dayMean[id] = own.mean;
                const line = fallen.has(id) ? (seasonRate(pl, id) || 0) : num(pl.source.projected[id]) / pl.games;
                expected[id] = (expected[id] || 0) + line * pl.appearances;
                const floor = floorOf(pl.group, id);
                const lift = !(own.variance > 0) && floor > 0 && pl.seatGames > 0;
                if (lift && scored.includes(id) && !specOf(id)) basis.floored += 1;
                variance[id] = (variance[id] || 0) + (own.variance > 0 ? own.variance : floor) * pl.seatGames;
            });
        });

        const values = {};
        const missing = [];
        scored.forEach(id => {
            const spec = specOf(id);
            if (!spec) {
                if (dead.has(id)) { missing.push({ statId: id, reason: 'no line' }); return; }
                values[id] = { current: num(board[id]), expectedRemaining: expected[id] || 0, sd: Math.sqrt(variance[id] || 0) };
                return;
            }
            const comps = componentsOf(spec, specs);
            if (comps.some(c => dead.has(c))) { missing.push({ statId: id, reason: 'no line' }); return; }
            const finish = { ...board };
            comps.forEach(c => { finish[c] = num(board[c]) + (expected[c] || 0); });
            const projected = rateOf(finish, spec, specs);
            if (projected === null) { missing.push({ statId: id, reason: 'no denominator' }); return; }
            // How far one more of a component moves the rate, read off the finish by a small step.
            const slope = {};
            comps.forEach(c => {
                const step = Math.max(1e-6, Math.abs(finish[c]) * 1e-6);
                const up = rateOf({ ...finish, [c]: finish[c] + step }, spec, specs);
                slope[c] = up === null ? 0 : (up - projected) / step;
            });
            let spread = 0;
            players.forEach(pl => {
                const brought = comps.filter(c => pl.dayMean[c] !== undefined);
                let move = momentsOver(pl.dayLines, line => brought.reduce((sum, c) => sum + slope[c] * (num(line[c]) - pl.dayMean[c]), 0)).variance;
                if (!(move > 0)) move = brought.reduce((sum, c) => sum + slope[c] * slope[c] * floorOf(pl.group, c), 0);
                spread += move * pl.seatGames;
            });
            values[id] = { current: projected, expectedRemaining: 0, sd: Math.sqrt(spread) };
        });
        return { values, basis, missing };
    };

    const a = build(mine);
    const b = build(theirs);
    const basis = { periodsLeft: ctx.periodsLeft.length, mine: a.basis, theirs: b.basis };
    if (points) return { mine: a.values, theirs: b.values, rule: { scoring: 'points' }, leftOut: [], basis };

    // A category one side cannot form is not a contest, so it leaves both sides and the rule.
    const leftOut = [];
    a.missing.forEach(x => leftOut.push({ statId: x.statId, reason: x.reason, side: 'mine' }));
    b.missing.forEach(x => leftOut.push({ statId: x.statId, reason: x.reason, side: 'theirs' }));
    const gone = new Set(leftOut.map(x => x.statId));
    gone.forEach(id => { delete a.values[id]; delete b.values[id]; });
    const kept = scored.filter(id => !gone.has(id));
    if (!kept.length) return null;

    const rule = {
        scoring: 'categories',
        scoredStatIds: kept,
        inverseStatIds: (ctx.inverseStatIds || []).map(key).filter(id => kept.includes(id)),
        countingStatIds: kept.filter(id => !specOf(id)),
        tie: ctx.tie || { rule: 'NONE', statId: null }
    };
    // A sport nobody has measured carries no rho at all, so its categories fold as independent.
    const rho = MATCHUP_RHO[ctx.sport];
    if (rho !== undefined) rule.rho = rho;
    return { mine: a.values, theirs: b.values, rule, leftOut, basis };
}
