/**
 * My team against one opponent, category by category, over a window that has been played or is
 * projected. Also each side's workload over the window, a points league's weights by category,
 * and the day-by-day strip of listed pitching starts for both rosters.
 *
 * Nothing here costs a request. A played window comes from team totals the league payload already
 * carries, with its rates already computed by ESPN. A projected window is each rostered player's
 * rate per game times the club's games in the window, and its rates are rebuilt from projected
 * components, since a team's rate is not the sum of its players'.
 *
 * Pure. No DOM, no application state and no network; every table arrives as an argument.
 *
 * Contract: tests/fixtures/team-compare.md
 * Tests: tests/team-compare.test.html
 * @module team-compare
 */

// One rate rebuilt from its components: a numerator over a denominator, with an optional scale, or a sum of other rates. Null when a component is missing or the denominator is zero, since a zero denominator is not a zero rate.
function rateFrom(comp, totals) {
    if (!comp) return null;
    if (comp.add) {
        let sum = 0;
        for (const id of comp.add) {
            const part = totals[id];
            if (part === undefined || part === null || !Number.isFinite(part)) return null;
            sum += part;
        }
        return sum;
    }
    const add = (ids) => {
        let sum = 0;
        for (const id of ids || []) {
            const v = totals[id];
            if (v === undefined || v === null || !Number.isFinite(v)) return null;
            sum += v;
        }
        return sum;
    };
    const num = add(comp.num), den = add(comp.den);
    if (num === null || den === null || !den) return null;
    return (num * (comp.scale || 1)) / den;
}

// A team's totals for one window, from each player's projected figures per game and the club's games in the window. Component ids are summed whether or not the league scores them, since a scored rate needs them.
function projectedTotals(players) {
    const out = {};
    (players || []).forEach(p => {
        const games = Number(p && p.games) || 0;
        if (!games) return;
        Object.entries((p && p.rates) || {}).forEach(([id, perGame]) => {
            const v = Number(perGame);
            if (!Number.isFinite(v)) return;
            out[id] = (out[id] || 0) + v * games;
        });
    });
    return out;
}

// Which side is ahead. Direction is applied here and only here: the edge stays mine less theirs whatever the category, and the leader is the one field that knows which way the category runs.
function leaderOf(mine, theirs, lowerIsBetter) {
    if (mine === null || theirs === null) return null;
    if (mine === theirs) return 'tied';
    const mineAhead = lowerIsBetter ? mine < theirs : mine > theirs;
    return mineAhead ? 'mine' : 'theirs';
}

// Each side's workload over the window: how many games its lineup still gets and how many starts its staff has. Every schedule figure arrives from the caller. A start ESPN lists and a start estimated past what ESPN has listed are kept apart, since they are different claims. A reliever has no starts and is not counted in them.
function workloadFor(players, ctx) {
    const w = ctx.workload;
    if (!w) return null;
    const periods = (ctx.window && ctx.window.periods) || [];
    const byTeamGames = w.byTeamGames || new Map();
    const active = w.activeSlots || null;
    const reserve = w.irSlots || new Set();
    const startsByPlayer = w.startsByPlayer || new Map();
    const starterIds = w.starterIds || new Set();

    const clubRow = (p) => byTeamGames.get(Number(p.proTeamId)) || null;

    let il = 0;
    (players || []).forEach(p => { if (reserve.has(p.slot)) il += 1; });

    // With no table of which slots are seats, the seated figures cannot be answered and read null. Counting everyone not in the injury slot would count the bench as seated.
    let hitterGames = null;
    const playing = new Set();
    if (active) {
        // Hitter games count active seats only, since a bench bat's games are not games this team gets.
        hitterGames = 0;
        (players || []).forEach(p => {
            if (p.pitcher || !active.has(p.slot)) return;
            const row = clubRow(p);
            if (!row) return;
            hitterGames += row.games;
            row.byPeriod.forEach((n, period) => { if (n) playing.add(period); });
        });
    }
    // An off day is a day of the window on which this lineup has nobody playing.
    const offDays = (active && periods.length) ? periods.filter(p => !playing.has(Number(p))).length : null;

    if (!w.countsStarts) {
        return { starts: null, hitterGames, offDays, il };
    }

    // Starts count the whole staff, the bench included: a lineup is set daily, so a benched arm's listed turn is one move away. An arm in the injury slot is left out, by slot and never by injury status.
    let probable = 0, estimated = 0, listed = 0;
    (players || []).forEach(p => {
        if (!p.pitcher || reserve.has(p.slot) || !starterIds.has(p.id)) return;
        const listing = startsByPlayer.get(p.id);
        if (listing && Number.isFinite(listing.starts)) listed += listing.starts;
        const expected = w.expectedAppearances && w.expectedAppearances(p, {
            projectedStarts: listing ? listing.remaining : null,
            startsScheduled: true
        });
        if (expected && expected.unit === 'starts') { probable += expected.count; return; }
        if (expected && Number.isFinite(expected.count)) estimated += expected.count;
    });
    return {
        // The listed count is every turn ESPN has posted inside the window, played or not. The other three look forward and are not interchangeable with it.
        starts: { count: probable + estimated, probable, estimated, listed },
        hitterGames, offDays, il
    };
}

// Whether an edge is within the margin this league decides the category by. Null, never false, with no margins to measure against, and a page then draws no marker.
function swingOf(edge, id, margins) {
    if (!margins || !margins.byId) return null;
    const row = margins.byId[String(id)];
    if (!row || !Number.isFinite(row.marginSd) || row.marginSd <= 0) return null;
    if (edge === null || !Number.isFinite(edge)) return null;
    return Math.abs(edge) <= row.marginSd;
}

// The window's date range, through the caller's own formatter. The ends are the earliest and latest dated days in the window, not its first and last periods, so a window opening on a day with no game still has a range.
function rangeOf(win, ctx) {
    const byPeriod = ctx && ctx.datesByPeriod;
    const labelOf = ctx && ctx.rangeLabelOf;
    if (!byPeriod || typeof labelOf !== 'function') return null;
    let first = null, last = null;
    (win.periods || []).forEach(p => {
        const at = byPeriod.get(Number(p));
        if (at === undefined || at === null) return;
        if (first === null) first = { period: Number(p), at };
        last = { period: Number(p), at };
    });
    if (!first) return null;
    const label = labelOf(first.at, last.at, first.period, last.period);
    return (typeof label === 'string' && label) ? label : null;
}

/**
 * A points league's weight for each scored stat, from its scoring items.
 *
 * The weight is the item's points, except for a stat that is worth nothing on its own and is
 * given one value by a lineup slot's override, where it is that value. A stat whose override
 * differs from its base has no single weight and reads null, since a team's total does not say
 * which slot earned what.
 *
 * @param {Array<{statId: *, points: number, pointsOverrides: Object<string, number>}>} scoringItems The league's scoring items.
 * @returns {Object<string, ?number>} Points per unit by stat id; null where no single weight exists.
 */
export function categoryWeights(scoringItems) {
    const out = {};
    (Array.isArray(scoringItems) ? scoringItems : []).forEach(item => {
        if (!item || item.statId === undefined || item.statId === null) return;
        const points = Number(item.points);
        const own = Number.isFinite(points) ? points : 0;
        const overrides = [...new Set(Object.values(item.pointsOverrides || {}).map(Number).filter(Number.isFinite))];
        let weight;
        if (!overrides.length) weight = own;
        else if (overrides.every(v => v === own)) weight = own;
        // Worth nothing by itself and one figure wherever it is overridden: a stat only that slot earns.
        else if (own === 0 && overrides.length === 1) weight = overrides[0];
        else weight = null;
        out[String(item.statId)] = weight;
    });
    return out;
}

const weightOf = (weights, id) => {
    const w = weights ? weights[id] : null;
    if (w === null || w === undefined || w === '') return null;
    const n = Number(w);
    return Number.isFinite(n) ? n : null;
};

/**
 * Compares two teams over a window, one row per scored category: each side's figure, the edge,
 * who leads, and whether the edge is within the league's usual margin. In a points league each
 * row also carries the points each side earned and the rows add up to each side's total.
 *
 * @param {{teamId: *, name: string}} mine My team.
 * @param {{teamId: *, name: string}} theirs The opponent.
 * @param {object} [ctx]
 * @param {{kind: ('played'|'projected'), periods: number[], matchup: ?number, label: ?string, asOf: *}} ctx.window The window.
 * @param {Array<string|number>} ctx.scoredIds The scored categories, in the order to list them.
 * @param {Object<string, string>} [ctx.statLabels] Labels by stat id.
 * @param {Set<string>} [ctx.lowerIsBetterIds] The categories where lower is better.
 * @param {Set<string>} [ctx.rateIds] The categories that are rates.
 * @param {object[]} [ctx.rateComponents] How each rate is rebuilt from components.
 * @param {Set<string>} [ctx.secondaryIds] The categories of the secondary role group.
 * @param {Object<string, object>} [ctx.played] Each team's totals by matchup and stat id, for a played window.
 * @param {Object<string, Array<{rates: object, games: number}>>} [ctx.projected] Each team's players with their rates per game and games in the window, for a projected one.
 * @param {Object<string, *>} [ctx.margins] The margin the league decides each category by.
 * @param {boolean} [ctx.isPointsLeague] Whether the league scores points.
 * @param {Object<string, ?number>} [ctx.weights] The weights from categoryWeights, required in a points league.
 * @param {object} [ctx.workload] Each team's roster and schedule figures, for the workload.
 * @param {Map<number, number>} [ctx.datesByPeriod] Each scoring period's date.
 * @param {function} [ctx.rangeLabelOf] Formats the window's date range.
 * @returns {?{window: object, mine: {teamId: *, name: ?string, workload: ?object}, theirs: {teamId: *, name: ?string, workload: ?object}, rows: object[], points: (object|undefined)}}
 *   Null when there is nothing to compare: no opponent, the same team twice, a window with no
 *   days, no scored categories, a projected window with a roster missing, or a points league
 *   with no weights.
 */
export function teamCompare(mine, theirs, ctx = {}) {
    // Refusal 1: a points league without its weights. The rows would carry values and no points.
    const points = !!ctx.isPointsLeague;
    if (points && (!ctx.weights || typeof ctx.weights !== 'object')) return null;
    // Refusal 2: no opponent, or the same team on both sides.
    if (!mine || !theirs || mine.teamId === undefined || theirs.teamId === undefined) return null;
    if (String(mine.teamId) === String(theirs.teamId)) return null;
    const win = ctx.window;
    // Refusal 3: a window with no days.
    if (!win || !Array.isArray(win.periods) || !win.periods.length) return null;

    const ids = (ctx.scoredIds || []).map(String);
    if (!ids.length) return null;
    const labels = ctx.statLabels || {};
    const lower = ctx.lowerIsBetterIds || new Set();
    const rateIds = ctx.rateIds || new Set();
    const comps = new Map((ctx.rateComponents || []).map(c => [String(c.out), c]));
    // Which role group a category belongs to, from the secondary ids the caller hands in. With none handed in the group is null on every row. The rows keep the caller's order.
    const secondaryIds = ctx.secondaryIds ? new Set([...ctx.secondaryIds].map(String)) : null;
    const groupOf = (id) => (secondaryIds ? (secondaryIds.has(id) ? 'secondary' : 'primary') : null);

    const projected = win.kind === 'projected';
    let totalsFor;
    if (projected) {
        const byTeam = ctx.projected || {};
        const mineRoster = byTeam[mine.teamId] || byTeam[String(mine.teamId)];
        const theirRoster = byTeam[theirs.teamId] || byTeam[String(theirs.teamId)];
        // Refusal 4: a projected window with no roster on either side.
        if (!mineRoster || !theirRoster || !mineRoster.length || !theirRoster.length) return null;
        const a = projectedTotals(mineRoster), b = projectedTotals(theirRoster);
        totalsFor = (side) => (side === 'mine' ? a : b);
    } else {
        // A played window comes from the team totals the payload already carries, per matchup.
        const byTeam = ctx.played || {};
        const read = (team) => {
            const rows = byTeam[team.teamId] || byTeam[String(team.teamId)] || {};
            const out = {};
            (win.matchup === null || win.matchup === undefined ? Object.keys(rows) : [win.matchup])
                .forEach(mp => {
                    const row = rows[mp] || rows[String(mp)];
                    if (!row) return;
                    Object.entries(row).forEach(([id, v]) => {
                        const n = Number(v);
                        if (Number.isFinite(n)) out[id] = (out[id] || 0) + n;
                    });
                });
            return out;
        };
        const a = read(mine), b = read(theirs);
        if (!Object.keys(a).length && !Object.keys(b).length) return null;
        totalsFor = (side) => (side === 'mine' ? a : b);
    }

    // One row of a points league: every field a category row has, and the weight, what each side earned from the category, and the edge in points. The edge stays mine less theirs in the category's own unit. The leader is who earned more points, so a negative weight needs no direction table. Where the points cannot be worked out there is no leader.
    const pointsRow = (id, a, b, isRate) => {
        const weight = weightOf(ctx.weights, id);
        // A rate is never weighted here, since what a points league would multiply for one has not been measured.
        const earned = (v) => (isRate || weight === null || v === null) ? null : v * weight + 0;
        const pa = earned(a), pb = earned(b);
        const both = pa !== null && pb !== null;
        return {
            id,
            label: labels[id] || String(id),
            group: groupOf(id),
            mine: a,
            theirs: b,
            edge: (a === null || b === null) ? null : a - b,
            leader: both ? (pa === pb ? 'tied' : (pa > pb ? 'mine' : 'theirs')) : null,
            lowerIsBetter: weight !== null ? weight < 0 : lower.has(id),
            rate: isRate,
            projected,
            swing: swingOf((a === null || b === null) ? null : a - b, id, ctx.margins),
            weight,
            minePoints: pa,
            theirPoints: pb,
            pointsEdge: both ? pa - pb : null
        };
    };

    const rows = [];
    ids.forEach(id => {
        const isRate = rateIds.has(id);
        const cell = (side) => {
            const totals = totalsFor(side);
            if (!isRate) {
                const v = totals[id];
                return v === undefined || v === null || !Number.isFinite(v) ? null : v;
            }
            // A played window's rate is ESPN's own for that matchup. Only a projected rate is rebuilt. A played window of several matchups cannot use the value per matchup, so the cell reads null unless its components are in the totals.
            if (!projected) {
                const single = win.matchup !== null && win.matchup !== undefined;
                if (single) {
                    const v = totals[id];
                    return v === undefined || v === null || !Number.isFinite(v) ? null : v;
                }
                return rateFrom(comps.get(id), totals);
            }
            // A rate with no rule for its components cannot be projected. Null, never a sum.
            return rateFrom(comps.get(id), totals);
        };
        const a = cell('mine'), b = cell('theirs');
        if (points) { rows.push(pointsRow(id, a, b, isRate)); return; }
        const lowerIsBetter = lower.has(id);
        rows.push({
            id,
            label: labels[id] || String(id),
            group: groupOf(id),
            mine: a,
            theirs: b,
            edge: (a === null || b === null) ? null : a - b,
            leader: leaderOf(a, b, lowerIsBetter),
            lowerIsBetter,
            rate: isRate,
            projected,
            swing: swingOf((a === null || b === null) ? null : a - b, id, ctx.margins)
        });
    });

    // The side's total is the sum of its rows, with a count of the rows that gave it nothing to add. Present only in a points league.
    const sideTotal = (key) => rows.reduce((acc, r) => {
        if (r[key] === null) acc.missing += 1; else acc.total += r[key];
        return acc;
    }, { total: 0, missing: 0 });
    const pointsOf = points ? (() => {
        const a = sideTotal('minePoints'), b = sideTotal('theirPoints');
        return { points: { mine: a, theirs: b, edge: a.total - b.total } };
    })() : {};

    return {
        ...pointsOf,
        window: {
            kind: win.kind === 'projected' ? 'projected' : 'played',
            label: win.label ?? null,
            matchup: win.matchup ?? null,
            periods: win.periods.slice(),
            asOf: win.asOf ?? null,
            // The window's date range, formatted by the caller. Null whenever it cannot be worked out.
            dates: rangeOf(win, ctx)
        },
        // The workload is carried on each side, since it is a fact about that team over the window. Null throughout when the caller passes none.
        mine: {
            teamId: mine.teamId, name: mine.name ?? null,
            workload: workloadFor((ctx.workload && ctx.workload.rosters
                && (ctx.workload.rosters[mine.teamId] || ctx.workload.rosters[String(mine.teamId)])) || [], ctx)
        },
        theirs: {
            teamId: theirs.teamId, name: theirs.name ?? null,
            workload: workloadFor((ctx.workload && ctx.workload.rosters
                && (ctx.workload.rosters[theirs.teamId] || ctx.workload.rosters[String(theirs.teamId)])) || [], ctx)
        },
        rows
    };
}


/**
 * The day-by-day strip of listed pitching starts for two rosters. Every day of the window gets a
 * row, including days on which nobody pitches. A day's date comes from the schedule and never
 * from the starts on it.
 *
 * @param {number[]} periods The window's scoring periods.
 * @param {{mine: object[], theirs: object[]}} [sides] Each side's pitchers, each with an id, a name and its listed games.
 * @param {object} [opts]
 * @param {Map<number, number>} [opts.datesByPeriod] Each scoring period's date.
 * @param {function(number): string} [opts.abbrevOf] A club's abbreviation by pro team id.
 * @param {function(number, ?number): string} [opts.labelOf] Formats a day's label.
 * @returns {Array<{period: number, date: ?number, label: ?string, mine: object[], theirs: object[]}>} One row per day, each side's starts with the opponent, the side and whether the start is still ahead.
 */
export function startStrip(periods, sides = {}, opts = {}) {
    const days = (periods || []).map(Number).filter(Number.isFinite);
    if (!days.length) return [];
    const { datesByPeriod = null, abbrevOf = null, labelOf = null } = opts;
    const within = new Set(days);

    // One side's listed starts, grouped by the day they fall on.
    const bucket = (roster) => {
        const byDay = new Map();
        (roster || []).forEach(p => {
            (p && p.games ? p.games : []).forEach(g => {
                if (!g || !within.has(Number(g.period))) return;
                const abbrev = abbrevOf && g.opponentId != null ? abbrevOf(g.opponentId) : null;
                const row = {
                    playerId: p.id ?? null,
                    name: p.name ?? null,
                    opponentId: g.opponentId ?? null,
                    isHome: !!g.isHome,
                    // Formatted here so both sides read alike. The pieces are beside it for a page that builds its own.
                    opponent: abbrev ? `${g.isHome ? 'vs' : '@'}${abbrev}` : null,
                    // Probable means still ahead. Every listing collected is already a probable one, so what the flag tells a reader is whether the start is a forecast or a result.
                    probable: !g.played,
                    period: Number(g.period)
                };
                const list = byDay.get(row.period) || [];
                list.push(row);
                byDay.set(row.period, list);
            });
        });
        // The order within a day is the order the roster was handed in, so two renders of one day agree.
        return byDay;
    };

    const mineByDay = bucket(sides.mine);
    const theirsByDay = bucket(sides.theirs);

    return days.map(period => {
        const date = datesByPeriod ? (datesByPeriod.get(period) ?? null) : null;
        return {
            period,
            date,
            label: labelOf ? labelOf(period, date) : null,
            mine: mineByDay.get(period) || [],
            theirs: theirsByDay.get(period) || []
        };
    });
}
