// How hard is a pitcher's next start. PURE - no DOM, no AppState, no fetches, so every weight is stated once, in one place, and hand-checkable in a test. The chain is ESPN's own data end to end, with no new source and no new host permission: the player pool every hitter, their proTeamId, season stats and injuryStatus proTeamSchedules_wl who plays whom, on which day, and which side is at home a per-day stat line externalId IS the ESPN game id for that line VALIDATED against real captures. A per-day stat line's externalId resolves against the schedule 82 of 82 times, which is what makes the last item true: a pitcher's own history can be split by opponent and by home or away without inferring anything from dates. What is deliberately NOT here: platoon splits. ESPN's fantasy payload carries no handedness at all. Checked across 1618 player objects, there is no bats or throws field, and statSplitTypeId only ever holds 0, 1 or 5, so there is nothing vs-LHP or vs-RHP to read. That half needs a source decision (docs/DATA-SOURCES.md) rather than a cleverer parse.

// A hitter counts toward his team's offence unless he cannot play. DAY_TO_DAY stays in, because a day-to-day hitter starts most days; the longer statuses are the ones that actually remove a bat.
const SIDELINED = new Set(['OUT', 'INJURY_RESERVE', 'SUSPENSION', 'SEVEN_DAY_DL', 'TEN_DAY_DL',
                           'FIFTEEN_DAY_DL', 'SIXTY_DAY_DL', 'NON_ROSTER']);

export function isSidelined(injuryStatus) {
    return SIDELINED.has(String(injuryStatus || '').toUpperCase());
}

// One team's offence, summed over the hitters who can actually play. Summed rather than averaged on purpose: a lineup is nine bats whoever they are, so a team that carries more rostered hitters should not read as a better offence for it. Injured bats drop out entirely, which IS the injury adjustment the owner asked for, applied at the only point where it changes an answer. Which categories can be summed, which have to be DERIVED, and which cannot be had at all. Summing a rate across players is meaningless twice over. The value is nonsense - sixteen players' OPS added together came out at 12.767 on a real lineup - and the comparison is biased, because a summed rate grows with how many healthy bats a club carries, so a deeper but worse lineup outranks a better one. Counting stats do not have that problem: more healthy bats genuinely is more offence. The house rule is the one the weekly pipeline and the roto race already follow. A rate is rebuilt from summed COMPONENTS, never from summed rates. Walked backwards from each scored rate so an `add` entry (OPS = OBP + SLG) pulls in the ratios it references, and kept in table order so those ratios are computed before the entry that sums them. A scored rate with no derivation available is EXCLUDED rather than summed. Shipping a number nobody can defend is worse than saying the category could not be measured, which is what the drill-in does with the list this returns.
function planOffenceRates(statIds, options) {
    const specs = options.rateSpecs || [];
    const rateIds = options.rateStatIds || new Set();
    const byOut = new Map(specs.map(s => [s.out, s]));

    const needed = new Map();
    const want = (id) => {
        if (needed.has(id) || !byOut.has(id)) return;
        const spec = byOut.get(id);
        needed.set(id, spec);
        (spec.add || []).forEach(want);
    };
    (statIds || []).forEach(want);

    const plan = specs.filter(s => needed.has(s.out));
    const sums = new Set();
    (statIds || []).forEach(id => { if (!needed.has(id)) sums.add(id); });
    plan.forEach(s => {
        (s.num || []).forEach(i => sums.add(i));
        (s.den || []).forEach(i => sums.add(i));
    });
    plan.forEach(s => sums.delete(s.out));

    const excluded = (statIds || []).filter(id => rateIds.has(id) && !needed.has(id));
    excluded.forEach(id => sums.delete(id));
    return { plan, sums, excluded };
}

// One derived rate from one lineup's summed components. Null when any component is missing, and null on a zero denominator - a lineup with no at-bats has no batting average, which is a different statement from having one of zero.
function deriveRate(totals, spec) {
    const total = (ids) => {
        let sum = 0;
        for (const id of ids) {
            const v = Number(totals[id]);
            if (!Number.isFinite(v)) return null;
            sum += v;
        }
        return sum;
    };
    if (spec.add) return total(spec.add);
    const num = total(spec.num || []);
    const den = total(spec.den || []);
    if (num === null || den === null || den === 0) return null;
    return num * (spec.scale || 1) / den;
}

// The bats that will actually be in the game, which is a LINEUP and not a roster. A club accumulates runs and home runs in proportion to how many players it carries, so counting categories were handing a deep organisation a better offence than a better lineup - the same depth bias the rates had, still live in most of what a league scores. Measured on a real pool: one club posted 825 runs across 51 bats where its everyday nine posted 560, and eleven of thirty clubs moved four or more places in the runs ranking once only the nine counted. A HARD COUNT rather than a share-of-leader threshold, because a fixed N is exactly depth-neutral. Every club brings the same number of bats, so carrying more players cannot bring more of anything. A threshold cannot say that: a club with twelve regulars would still out-total one with nine. Selected by playing time, never by production - the question is who is in the game, and picking the best hitters and then measuring how good they are would answer itself. Preseason keeps everyone. With nobody having played, the "most played" nine are nine arbitrary names, and the same guard the rank engine uses applies: rank on what there is rather than empty the board.
function lineupBats(bats, options) {
    const size = options.lineupSize;
    const playingTimeOf = options.playingTimeOf;
    if (!size || !playingTimeOf || bats.length <= size) return bats;
    const played = bats.map(h => Number(playingTimeOf(h)) || 0);
    if (!played.some(v => v > 0)) return bats;
    return bats
        .map((h, i) => ({ h, t: played[i] }))
        .sort((a, b) => b.t - a.t)
        .slice(0, size)
        .map(x => x.h);
}

// hitters: [{ proTeamId, injuryStatus, totals: { <statId>: value } }] options.rateSpecs / options.rateStatIds turn on the rate handling above, and options.lineupSize / options.playingTimeOf turn on the lineup selection. Absent, every healthy bat is counted and every id summed exactly as it always was, which is what a caller with only counting categories and a full roster wants.
export function teamOffence(hitters, statIds, options = {}) {
    const { plan, sums, excluded } = planOffenceRates(statIds, options);
    const byTeam = new Map();
    const sumIds = Array.from(sums);

    // Grouped first, so the lineup is chosen per club against that club's own bats.
    const healthyByTeam = new Map();
    (hitters || []).forEach(h => {
        if (!h || h.proTeamId == null) return;
        if (isSidelined(h.injuryStatus)) return;
        if (!healthyByTeam.has(h.proTeamId)) healthyByTeam.set(h.proTeamId, []);
        healthyByTeam.get(h.proTeamId).push(h);
    });

    healthyByTeam.forEach((bats, proTeamId) => {
        const lineup = lineupBats(bats, options);
        const team = { proTeamId, bats: lineup.length, rostered: bats.length, totals: {} };
        byTeam.set(proTeamId, team);
        lineup.forEach(h => {
            sumIds.forEach(id => {
                const v = Number(h.totals && h.totals[id]);
                if (Number.isFinite(v)) team.totals[id] = (team.totals[id] || 0) + v;
            });
        });
    });
    byTeam.forEach(team => {
        plan.forEach(spec => {
            const v = deriveRate(team.totals, spec);
            if (v === null) delete team.totals[spec.out];
            else team.totals[spec.out] = v;
        });
        // Deleted rather than left summed, so the basis finds nothing and the category drops out of the composite instead of poisoning it.
        excluded.forEach(id => { delete team.totals[id]; });
    });
    return byTeam;
}

// Where a value sits in a set, 0 to 100, by how many it beats. Ties share the midpoint so two identical offences cannot be ranked against each other by accident.
export function percentileOf(value, values) {
    const list = (values || []).filter(v => Number.isFinite(v));
    if (!list.length || !Number.isFinite(value)) return null;
    let below = 0, equal = 0;
    list.forEach(v => { if (v < value) below++; else if (v === value) equal++; });
    return ((below + equal / 2) / list.length) * 100;
}

// An offence's strength: its percentile in each category, averaged. That is the whole method. It used to run a SECOND pass, percentiling those averages against each other, to undo the compression an average of percentiles produces. Removed (, owner), because the compression it was compensating for came from defects that have since been fixed, and the pass had started doing real harm: - The measurement behind it ("the best offence came out at 72.5, so the top band could never fire") was taken when the composite ran over the LEAGUE's categories and over whole rosters. showed irrelevant categories cancel the relevant ones, and that roster depth flattened everything. On the four-category basket over lineups the averages already span 9.6 to 93.3 with a median of 52.1 and every difficulty band populated, so there is nothing left to restore. - It made the number stop meaning what it says. A lineup 90th in one category and 30th in another IS a middling offence; stretching that back out to 98 invents an extreme the categories do not show. - It needed a paragraph on screen to explain why the column did not add up to the total. A total that needs a disclaimer is the wrong total. Averaging percentiles is what makes runs and home runs comparable at all, which is the same trick the rank engine uses on players. That part stays, and it is now the only part. The set of values each category is ranked against, gathered once. Shared by the composite below and by offenceBreakdown, so the number a drill-in shows and the number the score was built from cannot drift apart - they are the same arithmetic over the same basis.
function offenceBasis(byTeam, statIds) {
    const teams = Array.from(byTeam.values());
    const perStat = new Map();
    (statIds || []).forEach(id => {
        perStat.set(id, teams.map(t => Number(t.totals[id])).filter(Number.isFinite));
    });
    return { teams, perStat };
}

// Where one category's value sits, with LOWER-IS-BETTER categories mirrored. Every scored category used to be ranked as if more were better, which is right for runs and home runs and backwards for the ones a league scores the other way. On a real pool that read 53 errors as the 77th percentile of offensive STRENGTH: a club that gives away more outs was being scored as a harder lineup to face. Mirroring is exact rather than approximate, because percentileOf splits ties down the middle - 100 minus it counts the values above instead of below, with the same half-share of the ties.
function categoryPercentile(value, values, inverse) {
    const p = percentileOf(value, values);
    if (p === null) return null;
    return inverse ? 100 - p : p;
}

// options.inverseStatIds: Set of the ids this league scores lower-is-better. Absent means none, which is exactly what a league scoring only counting categories needs and why every case written before still holds without being touched.
export function offenceStrength(byTeam, statIds, options = {}) {
    const { teams, perStat } = offenceBasis(byTeam, statIds);
    const inverse = options.inverseStatIds || new Set();

    const strength = new Map();
    teams.forEach(t => {
        const pcts = [];
        (statIds || []).forEach(id => {
            const p = categoryPercentile(Number(t.totals[id]), perStat.get(id), inverse.has(id));
            if (p !== null) pcts.push(p);
        });
        if (pcts.length) strength.set(t.proTeamId, pcts.reduce((a, b) => a + b, 0) / pcts.length);
    });
    return strength;
}

// ONE lineup's composite, taken apart into the per-category comparisons it was built from. This is the first pass of offenceStrength above, kept instead of thrown away. The panel showing a difficulty of 82 has to be able to answer "82 of what", and the honest answer is already computed - it was just never returned. So this returns it rather than recomputing anything: same basis, same percentileOf, same values, which is what makes the rows reconcile to the composite by construction instead of by luck. RANK counts how many lineups post MORE of the category, so 1 is the most. Ties share a rank, and the direction is the same one the composite uses: MORE is stronger, for every category the league scores. That is worth knowing before reading a row - a league scoring caught stealing or errors as a batting category will show a bad number ranked first, because the composite treats it that way too. The drill-in reports the engine, it does not quietly correct it. Returns null for a team the pool has no bats for, which is the same gap that makes a start read "No read" rather than an average one.
export function offenceBreakdown(byTeam, statIds, proTeamId, options = {}) {
    const { teams, perStat } = offenceBasis(byTeam, statIds);
    const team = teams.find(t => t.proTeamId === proTeamId);
    if (!team) return null;
    const inverseIds = options.inverseStatIds || new Set();
    const rows = [];
    (statIds || []).forEach(id => {
        const values = perStat.get(id) || [];
        const value = Number(team.totals[id]);
        const inverse = inverseIds.has(id);
        const pct = categoryPercentile(value, values, inverse);
        if (pct === null) return;
        // BETTER, not bigger. On a lower-is-better category the fewest ranks first, which is the same direction the percentile beside it now reads.
        let better = 0;
        values.forEach(v => { if (inverse ? v < value : v > value) better++; });
        rows.push({ id, value, pct, rank: better + 1, of: values.length, inverse });
    });
    // PASS ONE, returned so the panel can show its own arithmetic. offenceStrength is two passes, and the drill-in was showing the rows of the first under the result of the second - four percentiles averaging 16.9 beneath a total of 8, with nothing on screen to say a second step had happened. The score was right; the table did not add up to it. This is the same mean offenceStrength takes, over the same rows, so the two cannot disagree.
    const average = rows.length ? rows.reduce((a, r) => a + r.pct, 0) / rows.length : null;
    // The categories the composite could not measure, so the panel can name them rather than leaving a reader to notice a scored category is quietly missing from the table.
    return { proTeamId: team.proTeamId, bats: team.bats, rostered: team.rostered, rows, average,
             excluded: planOffenceRates(statIds, options).excluded };
}

// A pitcher's own past outings, split by who he faced and where. This is the join the module exists for. Each per-day line names its game through externalId, and the schedule says who was playing and which side was home, so a real head-to-head record falls out of data already in hand. lines: [{ externalId, totals: { <statId>: value } }] one per day the pitcher recorded a stat
export function pastStartsByOpponent(lines, gameIndex, pitcherTeamId) {
    const byOpponent = new Map();
    (lines || []).forEach(line => {
        const game = gameIndex && gameIndex.get(String(line && line.externalId));
        if (!game) return;
        const isHome = pitcherTeamId != null && game.home === pitcherTeamId;
        const opponentId = isHome ? game.away : game.home;
        if (opponentId == null) return;
        let rec = byOpponent.get(opponentId);
        if (!rec) { rec = { opponentId, outings: 0, home: 0, away: 0, totals: {} }; byOpponent.set(opponentId, rec); }
        rec.outings++;
        if (isHome) rec.home++; else rec.away++;
        Object.keys(line.totals || {}).forEach(id => {
            const v = Number(line.totals[id]);
            if (Number.isFinite(v)) rec.totals[id] = (rec.totals[id] || 0) + v;
        });
    });
    return byOpponent;
}

// Short rest, the one remaining flat adjustment. Under four days between starts is the usual definition of short rest, and the penalty is a documented order of magnitude rather than a tuned number.
export const SHORT_REST_DAYS = 4;
export const SHORT_REST_ADJUSTMENT = 6;

// Where the start is played, and what that venue does to run scoring. This replaces a pair of invented home/away constants. They asserted that being on the road is 8 points harder than being at home, everywhere, with nothing behind the number - which was worse than saying nothing, because a breakdown that itemises its reasoning has to mean the items. The venue effect those constants were standing in for is a measured, published quantity, so it is measured here instead. SOURCE: Baseball Savant's Statcast Park Factors leaderboard, baseballsavant.mlb.com/leaderboard/statcast-park-factors, retrieved. The values are its `index_runs` on the default 3-year rolling window, 2023-2025: 100 is a neutral run environment, 125 means 25% more runs scored there than at an average park. Three years rather than one because a single season of one park is a small sample and these move slowly; the leaderboard defaults to the same window for the same reason. Refreshed per release, per the embedded-constants ruling in docs/DATA-SOURCES.md section 4 - no runtime call, no host permission, no change to what leaves the browser. Keyed by ESPN's proTeamId, which is the id every other part of this chain already speaks, and the club's own park - so `isHome` plus the opponent's id names the venue with no new lookup. TWENTY-EIGHT of thirty, deliberately. The Athletics (11) and the Rays (30) are absent because Savant publishes no three-year factor for the temporary parks they moved into, and there is no honest way to fill that in: a minor-league park's run environment is not the one they left. They take the unknown-park path below, which contributes nothing and says so.
export const MLB_PARK_FACTORS = {
    1:  [100, 'Oriole Park at Camden Yards'],
    2:  [110, 'Fenway Park'],
    3:  [102, 'Angel Stadium'],
    4:  [98,  'Rate Field'],
    5:  [94,  'Progressive Field'],
    6:  [102, 'Comerica Park'],
    7:  [102, 'Kauffman Stadium'],
    8:  [94,  'American Family Field'],
    9:  [106, 'Target Field'],
    10: [100, 'Yankee Stadium'],
    12: [83,  'T-Mobile Park'],
    13: [94,  'Globe Life Field'],
    14: [100, 'Rogers Centre'],
    15: [102, 'Truist Park'],
    16: [94,  'Wrigley Field'],
    17: [106, 'Great American Ball Park'],
    18: [100, 'Daikin Park'],
    19: [102, 'Dodger Stadium'],
    20: [102, 'Nationals Park'],
    21: [96,  'Citi Field'],
    22: [102, 'Citizens Bank Park'],
    23: [98,  'PNC Park'],
    24: [100, 'Busch Stadium'],
    25: [94,  'Petco Park'],
    26: [94,  'Oracle Park'],
    27: [125, 'Coors Field'],
    28: [102, 'loanDepot park'],
    29: [106, 'Chase Field']
};

// Which club's park a start is played in. Home is the pitcher's own, away is the opponent's. Both ids are required, not just the one being used: `isHome` is itself derived from the pitcher's proTeamId upstream, so without that id there is no side to be on and the venue is unknown even though an opponent id is sitting right there. Returning null is what makes the breakdown say so.
export function venueTeamIdFor(start) {
    if (!start || start.teamId === null || start.teamId === undefined) return null;
    return start.isHome ? start.teamId : (start.opponentId ?? null);
}

// Difficulty of one projected start, 0 to 100, where higher is harder. The base is the opponent's offence percentile, which is the honest centre of the question: the hardest starts are against the best offences. Everything else is a documented nudge on top, and each is returned separately so a reader can disagree with the weighting and still use the parts. Returns null when the opponent's offence cannot be measured, which is a team the pool has no healthy hitters for. A null difficulty renders as "no read" rather than as an average one, since inventing a middling number would be worse than admitting the gap.
export function startDifficulty(start, offence, opponentHistory, options = {}) {
    if (!start || start.opponentId == null) return null;
    const base = offence && offence.get(start.opponentId);
    if (!Number.isFinite(base)) return null;

    // Each part carries a KEY as well as a label. The panel renders the three components differently - one is a percentile bar, one a signed delta, one a flat penalty - and it used to tell them apart by comparing the label text, which made a wording change a rendering bug waiting to happen.
    const parts = [{ key: 'offence', label: 'Opponent offence', value: base }];
    let score = base;

    // The park SCALES the opponent's offence rather than adding to it, which is what a run-scoring index is: 125 means a quarter more runs, so it makes this lineup a quarter harder to face, not "twelve points harder" in some unit nobody can check. Being a multiplier is also what keeps it a modifier rather than a co-equal component - it cannot turn a weak offence into a hard start, only make a hard one harder, and no constant had to be invented to hold it down. Applied to the base alone, never to the running score, so it stays independent of rest. Absent parkFactors means a sport that has no such thing, and the term does not appear at all (hockey). A park the table does not know is different, and says so with a zero.
    if (options.parkFactors) {
        const venueTeamId = venueTeamIdFor(start);
        const park = venueTeamId === null ? null : options.parkFactors[venueTeamId];
        if (park) {
            // Rounded to the tenth the breakdown prints at, so the component the panel shows is the component the total was built from. An unrounded multiply leaves 37.5 x 0.80 as -7.499999999999998, printed as -7.5 and summed as something else - a discrepancy of no consequence to the answer and every consequence to a panel whose whole job is showing its working.
            const adjustment = Math.round(base * (park[0] / 100 - 1) * 10) / 10;
            score += adjustment;
            parts.push({
                key: 'park', label: `${park[1]}, ${park[0]} run index`, value: adjustment,
                venue: park[1], runIndex: park[0], venueTeamId
            });
        } else {
            parts.push({ key: 'park', label: 'Ballpark unknown', value: 0, venue: null, runIndex: null, venueTeamId });
        }
    }

    // Absent rest is not zero rest. Number(null) is 0, which is finite and below the threshold, so reading it straight handed every FIRST start of a window a short-rest penalty it had not earned and labelled it "0 days rest". A pitcher with no previous start has no rest to measure, which is different from having none.
    const hasRest = options.restDays !== null && options.restDays !== undefined && options.restDays !== '';
    const rest = hasRest ? Number(options.restDays) : NaN;
    if (Number.isFinite(rest) && rest < SHORT_REST_DAYS) {
        score += SHORT_REST_ADJUSTMENT;
        parts.push({ key: 'rest', label: `${rest} days rest`, value: SHORT_REST_ADJUSTMENT, restDays: rest });
    }

    const history = opponentHistory && opponentHistory.get(start.opponentId);
    return {
        score: Math.max(0, Math.min(100, score)),
        base,
        parts,
        outings: history ? history.outings : 0,
        history: history || null
    };
}

// Plain words for a number nobody asked to be precise about. Five bands, because three is too blunt to separate a tough start from a brutal one and seven pretends to a precision this does not have.
export function difficultyLabel(score) {
    if (!Number.isFinite(score)) return 'No read';
    if (score >= 80) return 'Very hard';
    if (score >= 60) return 'Hard';
    if (score >= 40) return 'Even';
    if (score >= 20) return 'Favourable';
    return 'Very favourable';
}

// Days between two starts, from the game dates the schedule carries. Null when either date is missing, which is how an unplayed game with no date behaves and is why rest is optional above. The null check is separate from the isFinite one on purpose: Number(null) is 0, not NaN, so a missing date would otherwise read as the epoch and quietly produce a rest figure of 20000 days.
export function daysBetween(earlierMs, laterMs) {
    if (earlierMs === null || earlierMs === undefined || earlierMs === '') return null;
    if (laterMs === null || laterMs === undefined || laterMs === '') return null;
    const a = Number(earlierMs), b = Number(laterMs);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
}
