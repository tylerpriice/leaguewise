// The draft engine. Pure, like rank-engine.js and by the same contract: no DOM, no AppState, no fetches, every expected value in its tests hand-computed. The Draft tab's three faces (cheat sheet, mock draft, draft room) all read from here, so the number a player wears on the sheet is the number the room recommends the player by - one value engine, which was the first ruling the suite needed (one rank engine for the season, one draft engine in front of it, and the draft engine's VALUE is the rank engine's score over the projected lines, not a second z-score system that would rank the same player differently on two tabs).

// ==== Projected lines ====

// ESPN files a season projection beside the actuals in the same pool payload: statSourceId 1, splitTypeId 0, the season's year (validated on the live baseball capture, where every pooled player carries id "102026" next to the "002026" actuals - so the cheat sheet costs no request the leaderboard is not already making). A player with no projection is not "zero"; that player is unprojected, and null says so.
export function projectedLine(playerStats, year) {
    const line = (playerStats || []).find(s => s && s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === year);
    return line && line.stats ? line.stats : null;
}

// ==== Tiers ====

// Tier breaks fall where the VALUE drops, not every N players. `ranked` is best first with a numeric `value`; a break opens above the first player whose gap to the one before is at least `minGap`, and a tier never runs past `maxSize` players - a flat stretch of forty players is not one tier anyone can draft from, so it is cut at the largest gap inside it. Returns the 0-based indexes that START a new tier (index 0 is always tier one's start).
export function tierBreaks(ranked, { minGap = 4, maxSize = 12 } = {}) {
    const breaks = [0];
    if (!ranked || ranked.length < 2) return breaks;
    let start = 0;
    for (let i = 1; i < ranked.length; i++) {
        const gap = ranked[i - 1].value - ranked[i].value;
        if (gap >= minGap) { breaks.push(i); start = i; continue; }
        if (i - start >= maxSize) {
            // Cut at the widest gap inside the over-long run, which keeps the cut meaningful.
            let best = start + 1, bestGap = -Infinity;
            for (let j = start + 1; j <= i; j++) {
                const g = ranked[j - 1].value - ranked[j].value;
                if (g > bestGap) { bestGap = g; best = j; }
            }
            breaks.push(best); start = best;
            // The players after the cut are re-measured from the new start on the next passes.
            i = best;
        }
    }
    return breaks;
}

// Which tier a 0-based rank index sits in, 1-based, from the breaks above.
export function tierOf(index, breaks) {
    let t = 0;
    for (const b of breaks) { if (index >= b) t++; else break; }
    return t;
}

// ==== ADP ====

// The verdict in words, never a percentage (the threat-radar style rule). A player our value ranks well ahead of where the crowd takes them is FALLING - the pick lasts longer than the value says; one the crowd takes far earlier than our value is a REACH at that ADP. The band scales with the rank because a gap of eight at pick 10 is a different thing from eight at pick 150.
export function adpVerdict(valueRank, adp, { band = 0.25, floor = 6 } = {}) {
    if (!(valueRank > 0) || !(adp > 0)) return '';
    const tolerance = Math.max(floor, Math.round(valueRank * band));
    if (adp - valueRank >= tolerance) return 'falling';
    if (valueRank - adp >= tolerance) return 'reach';
    return '';
}

// Will the player last to the next pick? Words off the ADP distance, not a model nobody validated. `nextPick` is the overall pick number of the user's next turn.
export function survivalWord(adp, nextPick, currentPick) {
    if (!(adp > 0) || !(nextPick > 0)) return '';
    if (adp <= currentPick) return 'no';
    // How far BEFORE the next pick the crowd takes a player. Twelve picks of room is a round in a twelve-team league, and a round early is gone; six past the pick is a round's cushion.
    const room = nextPick - adp;
    if (room <= -6) return 'likely';
    if (room < 0) return 'coin flip';
    if (room < 12) return 'unlikely';
    return 'no';
}

// ==== Estimating what the projection will not say ====

// A CATEGORY ESPN NEVER PROJECTS, ESTIMATED FROM THE PLAYER'S OWN LAST SEASON. Some scored categories carry no projection for anyone - fielding is the standing example, since ESPN projects none of it. Dropping them would rank a league on a scoring system it does not use; treating a blank as zero is worse, because a zero in a "fewer is better" category is the best possible figure and would hand every player without a past a perfect score in it. So the figure is the player's own last-season RATE, carried forward over the games they are projected to play: (lastSeasonValue / lastSeasonGames) * projectedGames. It is one player's history, scaled to that player's own expected workload, and nobody else's. WHEN THERE IS NO ANSWER THERE IS NO NUMBER. No prior season, no games in it, or no projected games, and the id is left ABSENT rather than filled with a zero - a rookie is not a flawless fielder, but an unknown one, and the caller is expected to treat the gap as unknown rather than as nil. Rate categories are never estimated this way at all: a rate does not scale by games, and multiplying one by a game count produces a number with no meaning. Returns a NEW line - the projection is never mutated - and the ids that actually got a figure.
export function estimateUnprojected(projectedLine, lastSeasonLine, ids, { gamesId, rateIds } = {}) {
    const line = { ...(projectedLine || {}) };
    const rates = rateIds || new Set();
    const estimated = [];
    const projectedGames = Number((projectedLine || {})[gamesId]);
    const lastGames = Number((lastSeasonLine || {})[gamesId]);
    const scalable = !!lastSeasonLine && lastGames > 0 && projectedGames > 0;

    (ids || []).forEach(id => {
        if (rates.has(id)) return;
        if (line[id] !== undefined) return;
        if (!scalable) return;
        // A player who was there and never recorded one really did record none of them, which is a different statement from having no season to read.
        const had = Number(lastSeasonLine[id]) || 0;
        line[id] = (had / lastGames) * projectedGames;
        estimated.push(id);
    });

    return { line, estimated };
}

// ==== Replacement level ====

// WHAT A CATEGORY IS WORTH WHEN THE REPLACEMENT CANNOT BE MEASURED IN IT. The engine's own idiom for "no evidence": a percentile with nothing behind it shrinks to 50, the exact middle. A replacement player can genuinely have no figure in a category - a gated one with no opportunity in it, or a rate never posted - and the alternatives are both wrong. Skipping the category would erase a real edge (a closer's saves measured against a replacement starter gated out of saves entirely would count for nothing), and treating that player as a zero would hand out the whole percentile as free credit.
export const REPLACEMENT_UNKNOWN_PERCENTILE = 50;

// VALUE AS A SUM OF EDGES, NOT A MEAN OF THEM. In a categories league every category is one win or one standings column. A player who can move nine of them is worth more than one who moves five, and a MEAN throws that away - it divides the nine-category player's advantage back down by nine and calls the two equal. Summing keeps it: each category contributes its own edge over the player the league would otherwise start. Only the categories the player HAS a figure in are counted. One they do not - a rate never posted, or an estimate that could not be made - contributes neither credit nor debit, because an unknown is not a zero. Returns null when there are none at all, which is not the same as an edge of nothing.
export function sumOfEdges(playerPercentiles, replacementPercentiles) {
    if (!playerPercentiles || !playerPercentiles.size) return null;
    let sum = 0;
    playerPercentiles.forEach((pct, id) => {
        const base = replacementPercentiles && replacementPercentiles.has(id)
            ? replacementPercentiles.get(id)
            : REPLACEMENT_UNKNOWN_PERCENTILE;
        sum += pct - base;
    });
    return sum;
}

// HOW MANY OF EACH GROUP THE LEAGUE ACTUALLY STARTS, off its own lineup settings. `counts` is ESPN's lineupSlotCounts (slot id -> how many of that slot each team starts). `nonStarting` is the bench and injury slots, which never count - a bench seat is not a job anyone is replacing. `secondary` is the slot ids belonging to the second role group: pitching slots in baseball, the goalie slot in hockey. Everything else that starts is primary. One function so the board's replacement level and the scarcity card's starter count come from the same arithmetic - if these ever disagreed, the sheet would be telling a manager two different things about the same league in two panels an inch apart.
export function startingSlotsByGroup(counts, { nonStarting, secondary } = {}) {
    const skip = nonStarting || new Set();
    const second = secondary || new Set();
    let primary = 0, secondaryCount = 0;
    Object.keys(counts || {}).forEach(key => {
        const slot = Number(key);
        const n = Number(counts[key]) || 0;
        if (n <= 0 || skip.has(slot)) return;
        if (second.has(slot)) secondaryCount += n;
        else primary += n;
    });
    return { primary, secondary: secondaryCount };
}

// THE REPLACEMENT LEVEL: the score of the last player at this group the league still starts. With twelve teams starting two goalies each, the 24th best goalie is the one you could have anyway - so what a goalie is WORTH is what the goalie gives above that replacement, not how far above the goalie pool's middle the goalie sits. This is the whole reason a raw percentile cannot be merged across groups: two groups of different depth and different category counts produce different top ends from the same underlying quality (measured on a real pool: batters topping at 84.3 against pitchers at 98.4, on medians a point apart). `starters` is 1-based - the starters-th best player. A group shallower than the league's own starting requirement has no replacement to speak of, so its last player stands in; that is the honest floor rather than a zero that would make everyone look valuable.
export function replacementLevel(groupScores, starters) {
    const sorted = (groupScores || []).filter(s => Number.isFinite(s)).sort((a, b) => b - a);
    if (!sorted.length) return null;
    const want = Math.max(1, Math.floor(Number(starters) || 0));
    return sorted[Math.min(want, sorted.length) - 1];
}

// REPLACEMENT LEVEL PER POSITION. The one-group baseline above is right for a sport whose starters are interchangeable and wrong for football, where they are not - and it is wrong in BOTH directions, which is the part that went unreported for a year. Measured on the owner's 2026 league (10 teams, QB1 RB2 WR2 TE1 D/ST1 K1 FLEX1), one group 80 deep puts the baseline at 206.8 and: - EVERY kicker below it. 0 of 32, the best kicker in football 35 points short. Six of the ten tight ends a league MUST start also price below replacement, which cannot be true of a mandatory starter. - 28 QUARTERBACKS above it, where ten are started. The same arithmetic that buries kickers inflates quarterbacks, and only the buried half was ever reported. Per position: QB 292.0, RB 206.0, WR 204.1, TE 176.9, K 145.9, D/ST 100.5, leaving 9 of 10, 21 of 22, 27 of 28, 9 of 10, 9 of 10 and 9 of 10 above - a baseline at the Nth seat leaving about N-1 above it, in every position, which is the check that this is correct and not merely different. THE FLEX SHARE IS MEASURED, NEVER A FIXED SPLIT. Each position's own seats are MANDATORY and cannot be traded away - a league starting ten tight ends has a tenth-best tight end whatever that scores - so those are locked first, and the flex seats go to the best players left over. On that league it lands RB +2, WR +8, TE +0: the flex is a second-tier receiver seat there and a tight end never wins one. A hardcoded share would be exactly the guess this replaces, and it is league-specific - it falls out of the projections, not out of the sport. PURE, and it takes SCORES rather than players: rows are [{ pos, score }], so the engine needs to know nothing about ESPN's shapes or about how a projected line becomes a number.
export function positionDepths(rows, { counts = {}, labels = {}, bench = new Set(), flex = new Set(), flexPositions = {}, teams = 0 } = {}) {
    const byPos = new Map();
    (rows || []).forEach(r => {
        if (!r || !r.pos || !Number.isFinite(r.score)) return;
        if (!byPos.has(r.pos)) byPos.set(r.pos, []);
        byPos.get(r.pos).push(r.score);
    });
    if (!byPos.size) return [];
    byPos.forEach(list => list.sort((a, b) => b - a));

    // The mandatory seats: every non-bench, non-flex slot the league actually fields.
    const seats = new Map();
    const flexSeats = [];
    Object.keys(counts || {}).forEach(key => {
        const slot = Number(key);
        const n = Number(counts[key]) || 0;
        if (n <= 0 || bench.has(slot)) return;
        if (flex.has(slot)) { flexSeats.push({ slot, n: n * (Number(teams) || 0) }); return; }
        const label = labels[slot];
        if (!label) return;
        seats.set(label, (seats.get(label) || 0) + n * (Number(teams) || 0));
    });

    const won = new Map();
    const taken = new Map();          // how deep into each position the locked seats already reach
    seats.forEach((n, pos) => taken.set(pos, n));

    // A flex seat goes to the best player not already holding one of that position's own seats. Slots are filled MOST RESTRICTIVE FIRST (an RB/WR flex before a UTIL that takes anyone), which is the order that does not strand a narrow seat behind a wide one - a UTIL filled first could take the very player an RB/WR seat had no other candidate for.
    flexSeats
        .slice()
        .sort((a, b) => ((flexPositions[a.slot] || new Set()).size || Infinity)
                      - ((flexPositions[b.slot] || new Set()).size || Infinity))
        .forEach(({ slot, n }) => {
            const eligible = flexPositions[slot];
            // A flex slot whose positions have not been measured takes nobody here rather than everybody: guessing its eligibility is what FLEX_SLOT_POSITIONS exists to prevent, and a wrong guess moves every baseline it touches.
            if (!eligible || !eligible.size) return;
            for (let i = 0; i < n; i++) {
                let bestPos = null, bestScore = -Infinity;
                eligible.forEach(pos => {
                    const list = byPos.get(pos);
                    const at = taken.get(pos) || 0;
                    if (!list || at >= list.length) return;
                    if (list[at] > bestScore) { bestScore = list[at]; bestPos = pos; }
                });
                if (!bestPos) break;
                taken.set(bestPos, (taken.get(bestPos) || 0) + 1);
                won.set(bestPos, (won.get(bestPos) || 0) + 1);
            }
        });

    const out = [];
    seats.forEach((base, pos) => {
        const list = byPos.get(pos) || [];
        if (!list.length) return;
        const depth = base + (won.get(pos) || 0);
        // replacementLevel's own floor, kept: a position shallower than its seats has no replacement to speak of, so its last player stands in rather than a zero that would make everyone at it look valuable.
        const baseline = list[Math.min(depth, list.length) - 1];
        out.push({
            pos, seats: base, flexWon: won.get(pos) || 0, depth, baseline,
            above: list.filter(v => v > baseline).length, total: list.length
        });
    });
    return out.sort((a, b) => b.baseline - a.baseline);
}

// REPLACEMENT PER SEAT-GROUP. One baseline for a whole ranking group is right when its members are interchangeable and wrong when they are not. Hockey measures the wrong end of that: a league fielding five defencemen a team has a 25th-best defenceman, and pricing that player against the 75th-best SKATER buried the position - 4 of 317 defencemen above replacement, the best of them 21st among skaters. Against that own seat, first (measured, docs/RANKING-AUDIT.md). `groups` is [{ name, seats, accepts:Set<label> }] - each position slot with its own seats, and each FLEX slot as a group over the positions it accepts. `ranked` is the group's players best first, already scored by the engine, each carrying eligiblePositions. THE REPLACEMENT IS A PLAYER, not a number, for the same reason the single-group version says so: a category league subtracts that player's OWN percentile line, and assembling one from each category's Nth best would invent a player nobody could draft.
export function replacementByGroup(ranked, groups) {
    const out = new Map();
    (groups || []).forEach(g => {
        if (!g || !g.name || !g.accepts) return;
        const seats = Math.max(1, Math.floor(Number(g.seats) || 0));
        const mine = (ranked || []).filter(p => (p.eligiblePositions || []).some(v => g.accepts.has(v)));
        // A group nobody can fill has no replacement rather than a fabricated one.
        if (!mine.length) { out.set(g.name, null); return; }
        // Shallower than its own seats: the last player stands in, the floor replacementLevel keeps.
        out.set(g.name, mine[Math.min(seats, mine.length) - 1]);
    });
    return out;
}

// WHICH GROUP PRICES A PLAYER: the CHEAPEST seat the player could actually hold, by the group's own replacement score. AN APPROXIMATION, AND NAMED AS ONE. Which seat a player would really occupy depends on who else is competing for it - a matching problem, filed as O16 - and the exact version belongs there. The cheapest seat is the honest approximation because it is the one a manager would actually use the player in when every seat is otherwise fillable. Measured consequence worth knowing: a group whose baseline sits above every other group its members can reach never prices anybody. Hockey's UTIL is exactly that - a handful of seats over the whole skater pool - so it counts as a seat and sets no price. That is not a special case in the code, it falls out of taking the minimum.
export function pricingGroupFor(player, groups, replacements, scoreOf) {
    const eligible = (groups || []).filter(g => {
        const r = replacements.get(g.name);
        return r && (player.eligiblePositions || []).some(v => g.accepts.has(v));
    });
    if (!eligible.length) return null;
    let best = null, bestScore = Infinity;
    eligible.forEach(g => {
        const sc = scoreOf(replacements.get(g.name));
        if (sc === undefined || sc === null) return;
        if (sc < bestScore) { bestScore = sc; best = g; }
    });
    return best;
}

// ==== The order ====

// Snake order as a flat list of team ids, pick 1 first. `pickOrder` is ESPN's own first-round order (draftSettings.pickOrder), which the league payload carries; odd rounds walk it, even rounds walk it backwards. Linear order repeats it every round.
export function draftOrder(pickOrder, rounds, type = 'SNAKE') {
    const out = [];
    for (let r = 0; r < rounds; r++) {
        const row = (type === 'SNAKE' && r % 2 === 1) ? [...pickOrder].reverse() : pickOrder;
        out.push(...row);
    }
    return out;
}

// The overall pick numbers (1-based) at which one team picks.
export function picksFor(order, teamId) {
    const out = [];
    order.forEach((t, i) => { if (t === teamId) out.push(i + 1); });
    return out;
}

// ==== Scarcity ====

// How deep each position runs against what the league will draft of it. `starters` is the number of starting slots per position across the whole league (slots per team x teams), `available` the count of remaining players at that position with a value at or above the replacement level. The word is what the sheet prints; the ratio is what it is computed from, kept so a caller can sort by it. deep more than twice the starters remain short fewer than 1.5x remain cliff fewer remain than starters still to fill
export function scarcityOf(available, starters) {
    if (!(starters > 0)) return { ratio: Infinity, word: '' };
    const ratio = available / starters;
    if (ratio < 1) return { ratio, word: 'cliff' };
    if (ratio < 1.5) return { ratio, word: 'short' };
    if (ratio > 2) return { ratio, word: 'deep' };
    return { ratio, word: '' };
}

// SCARCITY, PRE-DRAFT. scarcityOf was written for the room, where it measures who is left against the starting jobs still to fill. Nothing has been taken yet here, so the literal reading is degenerate - count the players at or above the last starter and you have counted the starters. The question that IS live before a pick is how many players at this position are worth starting at all: everyone above the replacement level that group is measured against, against the number of jobs the league opens at that position. A league starting eight catchers with nine above replacement is a cliff, and that is what a manager needs before deciding when to reach. ONE PLAYER IS ONE BODY. Counting a player at every position they are eligible at made one player look like three: a hockey forward eligible at C, LW and RW was filling a C job AND a LW job AND a RW job at once, and every position read deeper than it is. Each player is assigned to exactly ONE position - greedily, to whichever of those eligible positions the league is furthest from filling at that moment - so the count is bodies against jobs, which is the comparison the words deep, short and cliff are about. Greedy rather than optimal on purpose. A true assignment would be a matching problem solved on every render for three thousand players; greedy balances the same way a draft does, and its failure mode is a position reading one body better or worse than a perfect assignment would say, which is well inside what "short" means.
export function assignBodies(players, jobsByPos) {
    const assigned = {};
    Object.keys(jobsByPos).forEach(pos => { assigned[pos] = 0; });
    (players || []).forEach(r => {
        let best = null;
        (r.player.eligiblePositions || []).forEach(pos => {
            if (!(jobsByPos[pos] > 0)) return;
            if (best === null) { best = pos; return; }
            const deficit = jobsByPos[pos] - assigned[pos];
            const bestDeficit = jobsByPos[best] - assigned[best];
            if (deficit > bestDeficit || (deficit === bestDeficit && pos.localeCompare(best) < 0)) best = pos;
        });
        if (best !== null) assigned[best] += 1;
    });
    return assigned;
}

// The league tables arrive as ARGUMENTS rather than being read here, which is what lets this live in the engine at all: draft-view supplies them from AppState, and the preseason face supplies the same shapes from the league it is describing. `counts` is lineupSlotCounts, `labels` and `bench` the sport rows of LINEUP_SLOT_LABELS and NON_STARTING_SLOTS, `teams` the league size.
export function positionDepth(rows, { counts = {}, labels = {}, bench = new Set(), flex = new Set(), teams = 0 } = {}) {

    const jobs = new Map();
    Object.keys(counts).forEach(key => {
        const slot = Number(key);
        const n = Number(counts[key]) || 0;
        const label = labels[slot];
        // A flex seat is not a position anyone is scarce at - it takes whoever is left over, so a shortage at one cannot be filled by definition. WHICH SEATS THOSE ARE IS DATA (FLEX_SLOTS in state.js, supplied by the caller beside labels and bench): this was three sports' vocabulary hardcoded here as LABELS, and football's FLEX was missing from it, which is why every football league read "FLEX cliff, none above replacement". A caller that names no flex seats therefore has none, rather than inheriting somebody else's guess at which words mean flex: the engine now knows nothing about any sport's slots, which is the whole point of the seats being data.
        if (n <= 0 || bench.has(slot) || !label) return;
        if (flex.has(slot)) return;
        jobs.set(label, (jobs.get(label) || 0) + n * teams);
    });

    const jobsByPos = {};
    jobs.forEach((n, pos) => { jobsByPos[pos] = n; });
    const worthStarting = rows.filter(r => r.value !== null && r.value >= 0);
    const bodies = assignBodies(worthStarting, jobsByPos);
    return Array.from(jobs.entries()).map(([pos, starters]) => {
        const available = bodies[pos] || 0;
        const { ratio, word } = scarcityOf(available, starters);
        return { pos, starters, available, ratio, word };
    }).sort((a, b) => a.ratio - b.ratio);
}

// ==== Bots ====

// A deterministic pseudo-random stream so a mock draft replays exactly from its seed - tests hand-compute against it, and a user can re-run the same draft after an undo. Mulberry32.
export function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// One bot pick. `candidates` is the remaining pool best-first by consensus (ADP, falling back to value); `needs` maps position -> open starting slots for this bot; `variance` is how far down the list a bot will reach (0 = always the top consensus player, 1 = anywhere in the top window). A bot prefers a player who fills an open slot, but only within the window - bots do not take a fourth goalie because it is open, and do not skip the best player on the board for a need below the window.
export function botPick(candidates, needs, variance, rand, { window = 6 } = {}) {
    if (!candidates || !candidates.length) return null;
    const span = Math.max(1, Math.round(window * variance)) ;
    const top = candidates.slice(0, Math.min(candidates.length, Math.max(1, span)));
    const fills = top.filter(c => (c.positions || []).some(p => (needs[p] || 0) > 0));
    const pickFrom = fills.length ? fills : top;
    const i = Math.floor(rand() * pickFrom.length);
    return pickFrom[Math.min(i, pickFrom.length - 1)];
}

// ==== The mock draft, as a state machine ====

// THE STATE IS A VALUE, NOT AN OBJECT WITH METHODS. Every transition returns a NEW state and mutates nothing, which is what makes undo a stack of states rather than a pile of inverse operations - and what lets a whole draft be re-run from a seed and land on the same picks. A state is cheap: ids, not players. order the flat list of team ids, pick 1 first (see draftOrder) pickIndex 0-based index of the pick ON THE CLOCK rosters team id -> the player ids it has taken, in the order taken picks { pick, teamId, playerId } per pick made, in order seed the number the run is reproducible from What is NOT stored is the remaining pool. It is the pool minus what the rosters hold, which the caller already has, and copying a three-thousand-id list into every undo step would make the stack the most expensive thing on the page.
export function initialDraftState(order, seed) {
    return { order: order || [], pickIndex: 0, rosters: {}, picks: [], seed: seed || 0 };
}

export function draftComplete(state) {
    return !state || state.pickIndex >= (state.order || []).length;
}

export function teamOnClock(state) {
    if (draftComplete(state)) return null;
    return state.order[state.pickIndex];
}

// One pick. A pick with no player, or made after the last pick, returns the state UNCHANGED - callers loop on this, and a transition that silently pretends to advance is how a loop spins.
export function applyPick(state, playerId) {
    if (draftComplete(state) || playerId === null || playerId === undefined) return state;
    const teamId = state.order[state.pickIndex];
    const held = state.rosters[teamId] || [];
    return {
        ...state,
        pickIndex: state.pickIndex + 1,
        rosters: { ...state.rosters, [teamId]: [...held, playerId] },
        picks: [...state.picks, { pick: state.pickIndex + 1, teamId, playerId }]
    };
}

// Run picks until the given team is on the clock, or the draft ends. `pickFor(state)` returns the id the team on the clock takes - the caller owns the pool, so it owns that choice; this owns the looping and the refusal to spin.
export function simToTeam(state, teamId, pickFor) {
    let s = state;
    let guard = (s.order || []).length + 1;
    while (!draftComplete(s) && teamOnClock(s) !== teamId && guard-- > 0) {
        const next = applyPick(s, pickFor(s));
        // No progress means no pick was available. Stopping is honest; looping is not.
        if (next.pickIndex === s.pickIndex) break;
        s = next;
    }
    return s;
}

// OPEN STARTING SLOTS PER POSITION for one roster. `rosterPositions` is one eligibility list per player already taken; `slots` is position -> how many of that position the team starts. A player eligible at several positions counts against each of them, which overstates how full a roster is for a multi-position player. That is deliberate and it is a BOT heuristic, not a lineup solver: the alternative is an assignment problem solved on every pick of every bot turn, and the error it prevents - a bot taking a fourth of something because a flex seat looked open - is smaller than the cost.
export function openNeeds(rosterPositions, slots) {
    const need = {};
    Object.keys(slots || {}).forEach(pos => {
        const filled = (rosterPositions || []).filter(list => (list || []).indexOf(pos) !== -1).length;
        need[pos] = Math.max(0, (slots[pos] || 0) - filled);
    });
    return need;
}

// ==== What the room can SAY - signal facts, no sentences ====

// A RUN, which is the one thing a draft does that a board cannot predict. Positions of the most recent picks, oldest first. Returns the position that has gone `threshold` times inside the last `window` picks, or null. Ties go to the more numerous, then alphabetically, so the same picks always produce the same sentence.
export function runDetect(recentPositions, { window = 6, threshold = 4 } = {}) {
    const slice = (recentPositions || []).slice(-window);
    const counts = new Map();
    slice.forEach(pos => { if (pos) counts.set(pos, (counts.get(pos) || 0) + 1); });
    let best = null;
    counts.forEach((n, pos) => {
        if (n < threshold) return;
        if (!best || n > best.count || (n === best.count && pos.localeCompare(best.position) < 0)) {
            best = { position: pos, count: n, of: slice.length };
        }
    });
    return best;
}

// WHERE A TEAM STANDS IN EACH CATEGORY AGAINST THE OTHER TEAMS, as picks land. The share of the OTHER teams this team is beating, 0 to 1, which is what a coverage bar means and what a manager can act on: half the league behind you is half the league behind you. Ties split, so two teams level in a category both read 0.5 rather than one of them being rewarded for sort order. An inverse category is won by the lower figure. Deliberately NOT the rank engine's percentile. That one places a player inside a pool of hundreds against a validated basis; this counts teams, of which a league has a handful, and borrowing the heavier definition would imply a precision six teams cannot carry. A ROSTER WITH NO FIGURE IN A CATEGORY IS NOT LOSING IT, it is absent from it. The distinction is not academic: rosterTotals returns null for a rate with no denominator, and reading that as zero would hand an empty roster the best earned run average in the league, since fewer is better there. A team with no figure is left out of the comparison from both sides, and a category nobody can be compared in has no share at all.
export function coverageOf(sumsByTeam, teamId, categoryIds, { inverseIds } = {}) {
    const inverse = inverseIds || new Set();
    const sums = sumsByTeam || {};
    const others = Object.keys(sums).filter(t => String(t) !== String(teamId));
    const mineAll = sums[teamId] || {};
    const figure = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    return (categoryIds || []).map(id => {
        const mine = figure(mineAll[id]);
        if (mine === null) return { id, share: null, value: null };
        let beaten = 0;
        let compared = 0;
        others.forEach(t => {
            const theirs = figure((sums[t] || {})[id]);
            if (theirs === null) return;
            compared += 1;
            if (theirs === mine) beaten += 0.5;
            else if (inverse.has(id) ? mine < theirs : mine > theirs) beaten += 1;
        });
        return { id, share: compared ? beaten / compared : null, value: mine };
    });
}

// A category this team is losing badly enough to call a hole.
export const COVERAGE_HOLE = 0.35;

export function holesFrom(coverage, threshold = COVERAGE_HOLE) {
    return (coverage || [])
        .filter(c => c && c.share !== null && c.share !== undefined && c.share <= threshold)
        .map(c => c.id);
}

// HOW MANY TEAMS PICKING BEFORE YOUR NEXT TURN HAVE AN OPEN SLOT AT THIS POSITION. Counted per TEAM, not per pick - a team drafting twice before you is one threat to a position, not two, and counting it twice would inflate every warning in a small league.
export function threatCount(order, fromIndex, toIndex, needsByTeam, position) {
    const seen = new Set();
    let n = 0;
    for (let i = Math.max(0, fromIndex); i < Math.min(toIndex, (order || []).length); i++) {
        const team = order[i];
        if (seen.has(team)) continue;
        seen.add(team);
        if (((needsByTeam || {})[team] || {})[position] > 0) n++;
    }
    return n;
}

// A ROSTER'S FIGURE IN EACH CATEGORY. Counting categories sum. RATES DO NOT - adding four batting averages together produces a number with no meaning - so a rate is rebuilt from its own components summed across the roster, which is the only way a team rate is ever correct. The FORMULAS are not invented here: they arrive as `rateSpecs`, the validated table the rest of the app already derives every team rate from. Null when a component is missing or a denominator is zero. A roster with no at-bats has no batting average, which is a different statement from having one of zero, and the coverage bar that reads this must be able to tell them apart.
function deriveRosterRate(sums, spec, specsById, seen) {
    const total = (ids) => {
        let out = 0;
        for (const id of ids || []) {
            const v = Number(sums[id]);
            if (!Number.isFinite(v)) return null;
            out += v;
        }
        return out;
    };
    // OPS is OBP plus SLG - a rate built from other rates, each of which has to be derived first.
    if (spec.add) {
        let out = 0;
        for (const id of spec.add) {
            const key = String(id);
            if (seen.has(key)) return null;
            const inner = specsById.get(key);
            const v = inner ? deriveRosterRate(sums, inner, specsById, new Set(seen).add(key)) : Number(sums[id]);
            if (v === null || !Number.isFinite(v)) return null;
            out += v;
        }
        return out;
    }
    const num = total(spec.num);
    const den = total(spec.den);
    if (num === null || den === null || den === 0) return null;
    return num * (spec.scale || 1) / den;
}

export function rosterTotals(lines, categoryIds, rateSpecs) {
    const specsById = new Map((rateSpecs || []).map(s => [String(s.out), s]));
    const sums = {};
    (lines || []).forEach(line => {
        Object.keys(line || {}).forEach(id => {
            const v = Number(line[id]);
            if (Number.isFinite(v)) sums[id] = (sums[id] || 0) + v;
        });
    });
    const out = {};
    (categoryIds || []).forEach(id => {
        const spec = specsById.get(String(id));
        out[id] = spec
            ? deriveRosterRate(sums, spec, specsById, new Set([String(id)]))
            : (sums[id] || 0);
    });
    return out;
}

// ==== A player who belongs to more than one group ====

// EDGES FROM EVERY GROUP A PLAYER ACTUALLY PLAYS IN. The engine ranks a player against one peer group, which is right for almost everybody and wrong for a two-way player: measured against batters, the pitching line is discarded, and someone who wins four pitching categories is valued as though they never pitched. Each part is one group's pair - those percentiles there and that group's OWN replacement player - so every edge is measured against the peers it belongs to and no category is counted twice, the groups being scored on disjoint category sets. A part the caller does not supply contributes nothing, which is how a player with no figures in a group is kept out of it: an empty pitching line would otherwise score that player at the bottom of the pitchers and subtract real value. A SECOND SKILL ADDS OR IT DOES NOTHING. IT NEVER SUBTRACTS. Only the groups above replacement are added. Measured on the live pool: the two-way player's batting is +78.1 and the pitching -5.7, because that player throws fewer innings than a full-time starter and a shallow league sets a high replacement bar. Summing both made the player WORSE for being able to pitch, which is exactly backwards - nobody is obliged to start that player on the mound. A manager plays a player where they help and fills the other seat from the pool, so a below-replacement second skill costs nothing and is worth nothing. When a player is below replacement everywhere, the least-bad group stands: they have to be played somewhere, and that is the seat it costs least to play them in. Null only when NO part scores at all - a player with nothing to measure anywhere.
export function sumOfEdgesAcross(parts) {
    const scored = [];
    (parts || []).forEach(part => {
        if (!part) return;
        const s = sumOfEdges(part.percentiles, part.replacement);
        if (s !== null) scored.push(s);
    });
    if (!scored.length) return null;
    const positive = scored.filter(s => s > 0);
    return positive.length
        ? positive.reduce((a, b) => a + b, 0)
        : scored.reduce((a, b) => (b > a ? b : a));
}

// ==== A column that is mostly one number ====

// WHEN AN AVERAGE DRAFT POSITION IS NOT ONE. Outside draft season ESPN collapses ADP to a cap: measured on a live mid-season pool, 2041 of 3000 players carry the identical 260.0, which is 68% of the column. That is not a draft position anyone was ever taken at, it is a filler, and every reading built on it - the board's delta, the verdict, a bot's consensus order, whether a player lasts to your next pick - is nonsense for two thirds of the pool. A real ADP column has ties, but not like this: genuine ties are a handful of players sharing a rounded value. One value covering more than a THIRD of the column cannot be a real draft position, and the gap between a third and the two thirds measured leaves the test in no danger of firing on real data. Returns the filler value, or null when the column is honest.
export function degenerateValue(values, { share = 1 / 3 } = {}) {
    const real = (values || []).filter(v => Number.isFinite(v));
    if (!real.length) return null;
    const counts = new Map();
    real.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
    let worst = null;
    counts.forEach((n, v) => {
        if (!worst || n > worst.n) worst = { v, n };
    });
    return worst && worst.n > real.length * share ? worst.v : null;
}
