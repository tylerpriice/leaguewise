// PURE. MY TEAM AGAINST THAT TEAM, CATEGORY BY CATEGORY, OVER A WINDOW. No DOM, no AppState, no fetches - every table arrives as an argument, the rule rank-engine.js, coverage-model.js and preseason-face.js follow. The frozen shape is tests/fixtures/team-compare.md. NOTHING HERE COSTS A REQUEST, which is why this shape and not another. A PLAYED window is already in hand: data.js builds each team's own per-category totals off the league payload (teamStats[...].weeklyCats), so the per-day player lines are not needed at all. A PROJECTED window is each rostered player's per-game rate times that club's games in that window, off atoms O11 already landed. THE ASYMMETRY THAT SHAPES EVERYTHING BELOW: a played window's rate categories arrive from ESPN ALREADY COMPUTED - the box score carries the team's AVG, ERA, OPS. A projected window's cannot be summed, because a team's AVG is not the sum of its players'. They are rebuilt from their components: project the numerator and denominator counts, then recompute the rate.

// One rate rebuilt from its components. Three shapes exist and all three are real (state.js): { num, den } AVG = H / AB { num, den, scale } ERA = ER * 9 / IP, where IP is outs/3, so the scale is 27 { add } OPS = OBP + SLG, a rate built from other rates NULL WHEN IT CANNOT BE BUILT - a missing component, or a zero denominator. A zero denominator is not a zero rate: a pitcher who has thrown no innings has no ERA, and printing 0.00 would make that arm the best in the league.
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

// A team's totals for one window. `players` is [{ rates, games }] - each player's projected PER-GAME figures and how many games the club plays inside the window. The per-game division happens at the caller, which knows the projected games; this only multiplies and sums. COMPONENT IDS ARE SUMMED WHETHER OR NOT THE LEAGUE SCORES THEM. A league scoring AVG but not AB still needs AB to rebuild AVG, so the caller supplies it in `rates` and it is summed here without ever becoming a row.
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

// WHICH SIDE IS AHEAD, and direction is applied HERE, exactly once. `edge` stays mine minus theirs whatever the category, so a reader of the number never has to know the rule; `leader` is the only field that knows it. A renderer flipping the sign itself would be a second place direction could be got wrong, and ERA is the category where it always is.
function leaderOf(mine, theirs, lowerIsBetter) {
    if (mine === null || theirs === null) return null;
    if (mine === theirs) return 'tied';
    const mineAhead = lowerIsBetter ? mine < theirs : mine > theirs;
    return mineAhead ? 'mine' : 'theirs';
}

export function teamCompare(mine, theirs, ctx = {}) {
    // Refusal 1: a points league has no per-category standing to compare - its categories are weighted into one number, and a table of weighted fragments answers nothing.
    if (ctx.isPointsLeague) return null;
    // Refusal 2: no opponent, or the same team on both sides.
    if (!mine || !theirs || mine.teamId === undefined || theirs.teamId === undefined) return null;
    if (String(mine.teamId) === String(theirs.teamId)) return null;
    const win = ctx.window;
    // Refusal 3: a window with no days is a matchup the league does not have.
    if (!win || !Array.isArray(win.periods) || !win.periods.length) return null;

    const ids = (ctx.scoredIds || []).map(String);
    if (!ids.length) return null;
    const labels = ctx.statLabels || {};
    const lower = ctx.lowerIsBetterIds || new Set();
    const rateIds = ctx.rateIds || new Set();
    const comps = new Map((ctx.rateComponents || []).map(c => [String(c.out), c]));

    const projected = win.kind === 'projected';
    let totalsFor;
    if (projected) {
        const byTeam = ctx.projected || {};
        const mineRoster = byTeam[mine.teamId] || byTeam[String(mine.teamId)];
        const theirRoster = byTeam[theirs.teamId] || byTeam[String(theirs.teamId)];
        // Refusal 4: a projected window with no roster - a pre-draft league has no team to project.
        if (!mineRoster || !theirRoster || !mineRoster.length || !theirRoster.length) return null;
        const a = projectedTotals(mineRoster), b = projectedTotals(theirRoster);
        totalsFor = (side) => (side === 'mine' ? a : b);
    } else {
        // A PLAYED window comes from the team totals the payload already carries, per matchup.
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

    const rows = [];
    ids.forEach(id => {
        const isRate = rateIds.has(id);
        const cell = (side) => {
            const totals = totalsFor(side);
            if (!isRate) {
                const v = totals[id];
                return v === undefined || v === null || !Number.isFinite(v) ? null : v;
            }
            // A PLAYED window's rate is ESPN's own, already computed for that matchup - the box score carries it, and rebuilding it would be a second path to a number the payload hands over. Only a PROJECTED rate is rebuilt. A MULTI-MATCHUP PLAYED window cannot use ESPN's per-matchup value: averaging two matchups' batting averages is not the batting average of the two, and summing them is nonsense. Such a cell reads null unless its components are themselves in the totals.
            if (!projected) {
                const single = win.matchup !== null && win.matchup !== undefined;
                if (single) {
                    const v = totals[id];
                    return v === undefined || v === null || !Number.isFinite(v) ? null : v;
                }
                return rateFrom(comps.get(id), totals);
            }
            // A rate with no component mapping cannot be projected at all - null, never a sum, because a summed rate is a confident wrong number rather than a missing one.
            return rateFrom(comps.get(id), totals);
        };
        const a = cell('mine'), b = cell('theirs');
        const lowerIsBetter = lower.has(id);
        rows.push({
            id,
            label: labels[id] || String(id),
            mine: a,
            theirs: b,
            edge: (a === null || b === null) ? null : a - b,
            leader: leaderOf(a, b, lowerIsBetter),
            lowerIsBetter,
            rate: isRate,
            projected
        });
    });

    return {
        window: {
            kind: win.kind === 'projected' ? 'projected' : 'played',
            label: win.label ?? null,
            matchup: win.matchup ?? null,
            periods: win.periods.slice(),
            asOf: win.asOf ?? null
        },
        mine: { teamId: mine.teamId, name: mine.name ?? null },
        theirs: { teamId: theirs.teamId, name: theirs.name ?? null },
        rows
    };
}
