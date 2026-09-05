// PURE. The PROJECTED basis for a league that has drafted but not played. Rosters times projected lines, scored by the engines the app already uses - no second scoring path, so a projected standing and the draft board's own value can never disagree. No DOM, no AppState, no fetches. The roto scorer arrives as an argument like every other table, which is also what keeps this module from importing rank-engine and dragging its ctx along.

import { valueFrom, sumPlayers, idsToSum } from './coverage-model.js';

// THE PROJECTED LINE IS THE CALLER'S CHOICE, not this module's. The draft board reads a player's projected totals through estimateUnprojected - which fills a category ESPN did not forecast from last season - and the whole point of this basis is to agree with that board, so the caller hands in the same line it already built rather than this module inventing a second reading of it. `lineOf` takes a player and returns the stat bag to count. Default is the raw projected totals, which is right for a caller that has no estimator to hand.
export function projectedTeamSums(rostersByTeam, { categoryIds, components, lineOf } = {}) {
    const ids = idsToSum(categoryIds || [], components);
    const read = lineOf || ((p) => (p && p.projectedTotals) || {});
    const out = {};
    Object.keys(rostersByTeam || {}).forEach(teamId => {
        // sumPlayers reads seasonTotals by contract, so each player is presented under that name with the projected line in it. One shape for both bases is what lets the same summing, the same rate recomputation and the same coverage code serve a projected league.
        const asSeason = (rostersByTeam[teamId] || []).map(p => ({ seasonTotals: read(p) }));
        out[teamId] = sumPlayers(asSeason, ids);
    });
    return out;
}

// PURE. WHAT A PLAYER IS STILL EXPECTED TO PRODUCE, over a window of his club's games. One derivation, read by every surface that needs a remainder, so two cards on the same tab can never be summing different bases. WHY IT IS DERIVED AND NOT READ. ESPN ships a rest-of-season line (statSourceId 1) and for most players it really is one - MEASURED on a live 2026 baseball league at scoring period 164 of 187, 383 of 424 hitters with 100+ at-bats carry a remainder-shaped line, and their sum reproduced the tab's own figures exactly. But 14 of those 424 - 3.3% - carry a PRESEASON FULL-SEASON projection ESPN never refreshed, and the surface printed one of them as a remainder: a free agent "would add 29 home runs the rest of the way" with three weeks left, off a line of 29 in 629 at-bats. A full season, printed as three weeks. THERE IS NO FLAG TO FILTER ON. Of those 14, seven read ACTIVE and seven are injured - and the player in the owner's report is one of the ACTIVE ones, so an injury filter would have left the number on screen. Only the arithmetic catches it, which is why every player goes through the same expression rather than a freshness test choosing between two. THE RATE'S UNIT MUST MATCH THE SPAN'S UNIT, and everything else here follows from that one rule. The line is the player's production PER APPEARANCE times the appearances he is expected to make, and expectedAppearances above says how many those are and what they are counted in. CROSSING THE UNITS IS THE DEFECT THIS FUNCTION HAS BEEN REWRITTEN TWICE TO AVOID. A per-start rate multiplied by a club's remaining games offered two starting pitchers as adds worth 152 and 159 strikeouts over three weeks of baseball - each of them a whole season. rank-engine.js's GAMES_PLAYED_IDS comment is the standing warning that club games are not a player's games; that was the warning arriving as a number on screen. A batter is nearly immune - he plays 94-99% of his club's games, so the two readings differ by a rounding - which is exactly why measuring home runs alone did not catch it. THE TWO UNITS ARE THE SAME EXPRESSION, which is why this is one function and not two: 'games' - the share, played/clubPlayed x clubRemaining, so (n/played) x count reduces to n/clubPlayed x clubRemaining: production per CLUB game over the club's games left. Every existing caller, and the same figures as before this amendment. 'starts' - ESPN's listed starts, so (n/played) x count is production per START over the starts he will actually make. Exact where it applies, and it applies only where ESPN has posted the whole window (see expectedAppearances). A starter's strikeouts stop being priced over his club's schedule and start being priced over his rotation turn, with no branch here at all. CHECKED AGAINST ESPN WHEREVER ESPN IS KEEPING THE LINE CURRENT, which is the evidence this rule is right rather than merely safe. Batters: Alvarez 5.5 against ESPN's 6, Rice 5.3 against 6, Schwarber 6.2 against 6, Freeman 2.5 against 3. Pitchers: Skubal 24.8 strikeouts against ESPN's 29, Alcantara 21.1 against 20. And the same expression takes the broken free agent from 29 home runs to 3.2. A RATE CARRIES THROUGH UNMULTIPLIED. A batting average over the rest of the way is still a batting average; multiplying it by twenty games produces a number with no unit that still sorts. The caller names its rate ids, the same way every other module here is handed its tables. NULL WITH NO GAMES, never zero. A player who has not played has no realized rate, and zero would say "expected to produce nothing", which is a forecast this data cannot make. It is the same refusal coverage-model's gainFrom already makes for a rate with no denominator. `gamesId` is only read for that refusal - the arithmetic never divides by it. TWO COSTS, recorded rather than discovered later. It throws away ESPN's own forecasting - regression, park, a changed role - and prices a player purely off what he has done. And it reads an early-season absence as a permanent rate: a player hurt in April and healthy now is priced down for the rest of the way (Carlos Correa, 32 of his club's 142 games, comes out at 0.4 home runs where ESPN says 15). Both buy a figure that can be checked against the record instead of trusted, and the second is visible to the reader as an injury badge on the same row. PURE. HOW MANY GAMES A PLAYER IS EXPECTED TO APPEAR IN over a window of his club's games - the same rule remainderLine is built on, exposed on its own for a caller that needs the COUNT rather than a scaled line. Returns `{ count, unit }`, and the UNIT is half the answer. A figure of appearances and a figure of club games are different quantities that both look like a number of games, and the surface that showed one as the other is what this exists to correct: the leaderboard told a manager his starting pitcher had "9 of 13 games left" in a matchup he would appear in twice. unit 'starts' - ESPN's own probable listings, counted. EXACT, and the same figure My Team's two-start badges already show, so the two surfaces cannot disagree. unit 'games' - the player's share of his club's games so far, over the games it has left. An estimate, and the only thing available for everyone else. WHEN STARTS ARE ALLOWED, and both conditions are load-bearing. The player must have a probable listed SOMEWHERE this season - MEASURED, 351 of a 3,000-player pool do and every reliever checked carries none, so it separates the rotation from the bullpen without a stat id to validate (golden rule 4) - and the window must END inside the horizon ESPN has actually listed. That second one is the constraint that makes this a rule rather than a preference: in the live capture the furthest probable is scoring period 174 while the season runs to 187, so counting probables across a rest-of-season window would find eleven days of a twenty-four day window and report the half as the whole. A starter whose next turn has not been posted yet fails the same way, one player at a time. THE SHARE IS RIGHT FOR A RELIEVER TOO, which is not what it looks like. A closer does not pitch every night either: 55 appearances in his club's 140 games is 39%, so over nine club games he appears in about three and a half, and showing him nine would be the same over-claim as showing a starter nine, only quieter. What differs between the roles is not the rule, only whether something exact exists. WHAT IT IS FOR. Anywhere a span is multiplied by a per-appearance rate, the span has to be APPEARANCES IN THE SAME UNIT AS THE RATE. Crossing them - a per-start rate times the club's games - is what printed a starter's whole season as three weeks, and this codebase has now made that mistake three times in three different surfaces. The unit travels with the count so the fourth is harder.
export function expectedAppearances(player, {
    gamesId, clubGamesPlayed, gamesRemaining, projectedStarts, startsScheduled, horizonEnd, windowEnd
} = {}) {
    if (!player) return null;
    // The exact answer first, and BEFORE the share's refusals: a pitcher called up this week has a listed start and no record to take a share of, and his real answer is the listing.
    const starts = Number(projectedStarts);
    const horizon = Number(horizonEnd);
    const end = Number(windowEnd);
    if (startsScheduled && Number.isFinite(starts) && starts >= 0
        && Number.isFinite(horizon) && Number.isFinite(end) && end <= horizon) {
        return { count: starts, unit: 'starts' };
    }
    const actual = player.seasonTotals || null;
    if (!actual || gamesId === null || gamesId === undefined) return null;
    const played = Number(actual[gamesId]);
    if (!Number.isFinite(played) || played <= 0) return null;
    const clubPlayed = Number(clubGamesPlayed);
    if (!Number.isFinite(clubPlayed) || clubPlayed <= 0) return null;
    const games = Number(gamesRemaining);
    if (!Number.isFinite(games) || games < 0) return null;
    return { count: (played / clubPlayed) * games, unit: 'games' };
}

export function remainderLine(player, opts = {}) {
    const { gamesId, rateIds } = opts;
    const actual = (player && player.seasonTotals) || null;
    if (!actual || gamesId === null || gamesId === undefined) return null;
    const played = Number(actual[gamesId]);
    // A rate needs a denominator on this side too. expectedAppearances can answer for a pitcher called up this week off his listing alone; a LINE cannot, because he has produced nothing to scale. Null rather than zero, the refusal gainFrom already makes for a rate with no games.
    if (!Number.isFinite(played) || played <= 0) return null;
    const expected = expectedAppearances(player, opts);
    if (!expected) return null;
    const rates = rateIds || new Set();
    const out = {};
    Object.keys(actual).forEach(id => {
        const raw = actual[id];
        if (raw === null || raw === undefined) return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        out[id] = rates.has(String(id)) ? n : (n / played) * expected.count;
    });
    return out;
}

// THE BOARD'S OWN CELLS, as a stat bag - the line to hand projectedTeamSums when the caller is working from a built board. A board row carries BOTH a `totals` bag and a `cells` array, and they are not the same reading for a TWO-WAY PLAYER. The board ranks once per group played, so the row's totals hold one group's line while the cells merge the groups, each category drawn by whichever group actually scores it. Summing totals therefore disagreed with summing what the board DISPLAYS - measured on the real capture, 1,696.08 against 1,699.66 in one category across 24 players, three other categories matching to the digit. The cells are what the board shows and what its value is built from, so the cells are the line.
export function lineFromCells(row, categoryIds) {
    const out = {};
    (categoryIds || []).forEach((id, i) => {
        const cell = row && row.cells && row.cells[i];
        const v = cell && cell.value;
        if (Number.isFinite(v)) out[id] = v;
    });
    return out;
}

// One team's projected value in every category, rates recomputed rather than summed - the same rule the coverage band follows, and for the same reason: a staff's ERA is its earned runs over its outs, not the average of its pitchers' ERAs.
export function projectedValues(sumsByTeam, categoryIds, components) {
    const out = {};
    Object.keys(sumsByTeam || {}).forEach(teamId => {
        const row = {};
        (categoryIds || []).forEach(id => { row[id] = valueFrom(sumsByTeam[teamId], id, components); });
        out[teamId] = row;
    });
    return out;
}

// PROJECTED ROTO STANDINGS, scored by the league's own roto engine rather than by anything written here. `scoreCategory` is rank-engine's rotoPointsForCategory, passed in: it owns the tie handling (categories split points when teams are level) and the rule that a team with no figure parks below every real one, both of which took validation against real captures to get right. Returns teams ordered as a standing, each carrying its per-category split so the projected heatmap and the category view can read the same numbers the order came from.
export function projectedRotoStandings(valuesByTeam, categories, scoreCategory) {
    const teamIds = Object.keys(valuesByTeam || {});
    const points = new Map(teamIds.map(t => [t, 0]));
    const byCategory = new Map(teamIds.map(t => [t, {}]));

    (categories || []).forEach(cat => {
        const entries = teamIds.map(t => ({ id: t, value: (valuesByTeam[t] || {})[cat.id] }));
        scoreCategory(entries, cat.inverse).forEach((pts, id) => {
            points.set(id, points.get(id) + pts);
            byCategory.get(id)[cat.id] = pts;
        });
    });

    return teamIds
        .map(id => ({ teamId: id, points: points.get(id), byCategory: byCategory.get(id) }))
        .sort((a, b) => b.points - a.points || String(a.teamId).localeCompare(String(b.teamId)));
}

// PROJECTED POINTS STANDINGS. A points league has no categories to score against each other - the projection IS the standing - so this is the sum of the roster's projected totals and nothing more. `totalOf` is the caller's, for the same reason lineOf is: the leaderboard already decided that ESPN's own appliedTotal is the figure, and this must not invent a second one.
export function projectedPointsStandings(rostersByTeam, totalOf) {
    const read = totalOf || ((p) => Number(p && p.projectedAppliedTotal) || 0);
    return Object.keys(rostersByTeam || {})
        .map(teamId => ({
            teamId,
            points: (rostersByTeam[teamId] || []).reduce((sum, p) => {
                const v = Number(read(p));
                return Number.isFinite(v) ? sum + v : sum;
            }, 0)
        }))
        .sort((a, b) => b.points - a.points || String(a.teamId).localeCompare(String(b.teamId)));
}

// Where one team sits in a standing, 1-based, or null when it is not in it. Ties SHARE a place, the same competition ranking the rest of the app uses - two teams projected level are both third and nobody is told they are fourth by a hair they did not lose by.
export function placeOf(standings, teamId) {
    const rows = standings || [];
    const at = rows.findIndex(r => String(r.teamId) === String(teamId));
    if (at === -1) return null;
    let place = 1;
    for (let i = 0; i < at; i++) {
        if (rows[i].points !== rows[at].points) place += 1;
    }
    return { place, of: rows.length, points: rows[at].points };
}
