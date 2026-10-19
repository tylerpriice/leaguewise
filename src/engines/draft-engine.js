/**
 * The draft's arithmetic, as pure functions: projected lines, tiers, verdicts against average draft
 * position, replacement level, scarcity, the mock draft's bots and its state.
 *
 * Pure. No DOM, no application state and no network. A player's value here is the rank engine's
 * score over projected lines, so the Draft tab and the season's rankings cannot disagree.
 *
 * Tests: tests/draft-engine.test.html
 * @module draft-engine
 */
/**
 * What a seat group is priced against: the players around its replacement rank.
 *
 * @typedef {object} ReplacementWindow
 * @property {object} player The player at the replacement rank itself.
 * @property {object[]} players The players in the window, in rank order.
 * @property {Array<number|string>} ids Their ids.
 * @property {number} window How many players either side of the rank the window reaches.
 * @property {number} index The replacement rank within the group's eligible players, from zero.
 * @property {object[]} eligible The group's eligible players in rank order.
 */
/**
 * A mock draft at one moment. Every transition returns a new state and changes nothing.
 *
 * @typedef {object} DraftState
 * @property {Array<number|string>} order The team ids in pick order, pick 1 first.
 * @property {number} pickIndex The pick on the clock, from zero.
 * @property {Object<string, Array<number|string>>} rosters Each team's player ids, in the order taken.
 * @property {Array<{pick: number, teamId: *, playerId: *}>} picks Every pick made, in order.
 * @property {number} seed The number the run is reproducible from.
 */

// ==== Projected lines ====

/**
 * A player's season projection, which ESPN files beside the actual totals in the same response.
 *
 * @param {object[]} playerStats The player's stat blocks.
 * @param {number} year The season.
 * @returns {?Object<string, number>} The projected line by stat id, or null for a player with none.
 */
export function projectedLine(playerStats, year) {
    const line = (playerStats || []).find(s => s && s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === year);
    return line && line.stats ? line.stats : null;
}

// ==== Tiers ====

/**
 * Where the tiers of a ranked list begin. A tier breaks where the value drops, and never runs
 * longer than a set size.
 *
 * @param {Array<{value: number}>} ranked The players, best first.
 * @param {object} [options]
 * @param {number} [options.minGap=4] The drop in value that opens a new tier.
 * @param {number} [options.maxSize=12] The most players one tier holds.
 * @returns {number[]} The indexes, from zero, at which a tier starts. Index 0 is always one.
 */
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

/**
 * Which tier a rank index sits in.
 *
 * @param {number} index The rank index, from zero.
 * @param {number[]} breaks What tierBreaks returned.
 * @returns {number} The tier, from one.
 */
export function tierOf(index, breaks) {
    let t = 0;
    for (const b of breaks) { if (index >= b) t++; else break; }
    return t;
}

// ==== ADP ====

/**
 * Whether a player is going later or earlier than the board values the player, in a word.
 *
 * @param {number} valueRank The player's rank by value.
 * @param {number} adp The player's average draft position.
 * @param {object} [options]
 * @param {number} [options.band=0.25] The tolerance as a share of the rank.
 * @param {number} [options.floor=6] The least the tolerance can be.
 * @returns {'falling'|'reach'|''} Empty when the two agree or either is missing.
 */
export function adpVerdict(valueRank, adp, { band = 0.25, floor = 6 } = {}) {
    if (!(valueRank > 0) || !(adp > 0)) return '';
    const tolerance = Math.max(floor, Math.round(valueRank * band));
    if (adp - valueRank >= tolerance) return 'falling';
    if (valueRank - adp >= tolerance) return 'reach';
    return '';
}

/**
 * Whether a player is likely to last to the reader's next pick, in a word, from the player's
 * average draft position.
 *
 * @param {number} adp The player's average draft position.
 * @param {number} nextPick The overall number of the reader's next pick.
 * @param {number} currentPick The overall number of the pick on the clock.
 * @returns {'likely'|'coin flip'|'unlikely'|'no'|''} Empty when either number is missing.
 */
export function survivalWord(adp, nextPick, currentPick) {
    if (!(adp > 0) || !(nextPick > 0)) return '';
    if (adp <= currentPick) return 'no';
    // How far before the next pick the crowd takes a player. Twelve picks of room is a round in a twelve-team league, and six past the pick is a round's cushion.
    const room = nextPick - adp;
    if (room <= -6) return 'likely';
    if (room < 0) return 'coin flip';
    if (room < 12) return 'unlikely';
    return 'no';
}

// ==== Estimating what the projection will not say ====

/**
 * Fills the counting categories ESPN projects for nobody, from the player's own last season
 * scaled to the games the player is projected to play. A rate is never estimated, and a player with
 * no last season is left without a figure.
 *
 * @param {?Object<string, number>} projectedLine The player's projected line.
 * @param {?Object<string, number>} lastSeasonLine The player's last season totals.
 * @param {string[]} ids The stat ids to fill where the projection has none.
 * @param {object} [options]
 * @param {string} [options.gamesId] The stat id that counts games played.
 * @param {Set<string>} [options.rateIds] The stat ids that are rates.
 * @returns {{line: Object<string, number>, estimated: string[]}} A new line, and the ids that were filled.
 */
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

// What a category counts for when the replacement player has no figure in it is the middle, 50. Skipping the category would erase a real edge, and a zero would hand out the whole percentile as credit.
const REPLACEMENT_UNKNOWN_PERCENTILE = 50;

/**
 * A player's value as the sum, over the categories the player has a figure in, of the player's
 * percentile less the replacement player's.
 *
 * @param {?Map<string, number>} playerPercentiles The player's percentile by stat id.
 * @param {?Map<string, number>} replacementPercentiles The replacement player's, by stat id.
 * @param {?Set<string>} [exclude] Categories shown and not priced.
 * @returns {?number} The sum, or null when no category was priced.
 */
export function sumOfEdges(playerPercentiles, replacementPercentiles, exclude = null) {
    if (!playerPercentiles || !playerPercentiles.size) return null;
    let sum = 0, counted = 0;
    playerPercentiles.forEach((pct, id) => {
        if (exclude && exclude.has(id)) return;
        const base = replacementPercentiles && replacementPercentiles.has(id)
            ? replacementPercentiles.get(id)
            : REPLACEMENT_UNKNOWN_PERCENTILE;
        sum += pct - base;
        counted += 1;
    });
    // Excluding every category is not a zero. A player with no priced category has no value, which is not the same as an average one.
    return counted ? sum : null;
}

/**
 * How many rounds the league's draft runs. The draft's own picks say so when there are any, and
 * the roster's seats are the fallback.
 *
 * @param {object} [options]
 * @param {?object[]} [options.picks] The draft's picks, each with its round.
 * @param {number} [options.slotsPerTeam] The seats a team drafts, used when there are no picks.
 * @param {number} [options.teams] The league's size.
 * @returns {number} The rounds, or 0 when nothing says.
 */
export function draftRoundCount({ picks = null, slotsPerTeam = 0, teams = 0 } = {}) {
    const size = Number(teams) || 0;
    if (Array.isArray(picks) && picks.length) {
        const maxRound = picks.reduce((m, p) => Math.max(m, Number(p && p.roundId) || 0), 0);
        if (maxRound > 0) return maxRound;
        // A format that carries picks with no round on them. The count of picks over the teams says it.
        return size ? Math.max(1, Math.round(picks.length / size)) : 0;
    }
    const seats = Number(slotsPerTeam) || 0;
    return seats > 0 ? Math.max(1, Math.round(seats)) : 0;
}

/**
 * The seats a league starts, each knowing its slot, its label and whether it is a flex seat.
 *
 * @param {Object<string, number>} counts How many of each lineup slot a team starts.
 * @param {object} [options]
 * @param {Object<string, string>} [options.labels] The label of each slot.
 * @param {Set<number>} [options.bench] The slots that do not start.
 * @param {Set<number>} [options.flexSlots] The slots that are flex seats.
 * @returns {{seats: Array<{slot: number, label: string, flex: boolean}>, byLabel: Object<string, number>,
 *   starters: number, flexSeats: number}} Every seat in slot order, the seats per position without
 *   the flex seats, and the two counts.
 */
export function lineupSeatsOf(counts, { labels = {}, bench = new Set(), flexSlots = new Set() } = {}) {
    const seats = [];
    const byLabel = {};
    Object.keys(counts || {})
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
        .forEach(slot => {
            const n = Number(counts[slot] ?? counts[String(slot)]) || 0;
            const label = labels[slot];
            // A slot with no label has not been measured for this sport, so it is skipped.
            if (n <= 0 || bench.has(slot) || !label) return;
            const flex = flexSlots.has(slot);
            for (let i = 0; i < n; i++) seats.push({ slot, label, flex });
            if (!flex) byLabel[label] = (byLabel[label] || 0) + n;
        });
    return { seats, byLabel, starters: seats.length, flexSeats: seats.filter(s => s.flex).length };
}

/**
 * How many seats a team starts in each of the two role groups.
 *
 * @param {Object<string, number>} counts How many of each lineup slot a team starts.
 * @param {object} [options]
 * @param {Set<number>} [options.nonStarting] The slots that do not start.
 * @param {Set<number>} [options.secondary] The slots of the second group.
 * @returns {{primary: number, secondary: number}}
 */
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

/**
 * The replacement level of a group: the score of the last player the league still starts.
 *
 * @param {number[]} groupScores The group's scores.
 * @param {number} starters How many of the group the league starts.
 * @returns {?number} That player's score. A group shallower than its seats gives its last score, and
 *   an empty one gives null.
 */
export function replacementLevel(groupScores, starters) {
    const sorted = (groupScores || []).filter(s => Number.isFinite(s)).sort((a, b) => b - a);
    if (!sorted.length) return null;
    const want = Math.max(1, Math.floor(Number(starters) || 0));
    return sorted[Math.min(want, sorted.length) - 1];
}

// Replacement level per position. Each position's own seats are filled first, then each flex seat goes to the best player left, so the share of flex seats a position wins is measured from the scores. Bodies worth starting are counted by value, a score at or above zero.
const worthyAt = (list) => list.filter(v => v >= 0).length;

/**
 * Each position's replacement level and depth, with the flex seats shared out by score.
 *
 * @param {Array<{pos: string, score: number}>} rows The players' positions and scores.
 * @param {object} [options]
 * @param {Object<string, number>} [options.counts] How many of each lineup slot a team starts.
 * @param {Object<string, string>} [options.labels] The label of each slot.
 * @param {Set<number>} [options.bench] The slots that do not start.
 * @param {Set<number>} [options.flex] The slots that are flex seats.
 * @param {Object<string, Set<string>>} [options.flexPositions] The positions each flex slot accepts.
 * @param {number} [options.teams] The league's size.
 * @returns {Array<{pos: string, seats: number, flexWon: number, depth: number, baseline: ?number,
 *   above: number, worthy: number, total: number}>} One row per position, hardest seat first.
 */
export function positionDepths(rows, { counts = {}, labels = {}, bench = new Set(), flex = new Set(), flexPositions = {}, teams = 0 } = {}) {
    const byPos = new Map();
    (rows || []).forEach(r => {
        if (!r || !r.pos || !Number.isFinite(r.score)) return;
        if (!byPos.has(r.pos)) byPos.set(r.pos, []);
        byPos.get(r.pos).push(r.score);
    });
    if (!byPos.size) return [];
    byPos.forEach(list => list.sort((a, b) => b - a));

    // The mandatory seats are every slot the league fields that is neither bench nor flex.
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

    // A flex seat goes to the best player not already holding one of that position's own seats. The narrowest flex seats are filled first, so a wide one cannot take the only candidate a narrow one had.
    flexSeats
        .slice()
        .sort((a, b) => ((flexPositions[a.slot] || new Set()).size || Infinity)
                      - ((flexPositions[b.slot] || new Set()).size || Infinity))
        .forEach(({ slot, n }) => {
            const eligible = flexPositions[slot];
            // A flex slot whose positions have not been measured takes nobody, since a guess would move every baseline it touched.
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

    // A position whose only seats are flex seats is still reported, with no seats of its own. So is every position a flex seat accepts, even one that won none.
    flexSeats.forEach(({ slot }) => {
        (flexPositions[slot] || new Set()).forEach(pos => { if (!seats.has(pos)) seats.set(pos, 0); });
    });
    won.forEach((_, pos) => { if (!seats.has(pos)) seats.set(pos, 0); });

    const out = [];
    seats.forEach((base, pos) => {
        const list = byPos.get(pos) || [];
        // A mandatory position with nobody in the pool is still a row, since seats with nobody to fill them is the loudest thing a depth read can say.
        if (!list.length) {
            if (base > 0) out.push({ pos, seats: base, flexWon: 0, depth: base, baseline: null, above: 0, worthy: 0, total: 0 });
            return;
        }
        const depth = base + (won.get(pos) || 0);
        // With no seat there is no baseline to be above, so the count above it is zero.
        if (depth <= 0) {
            out.push({ pos, seats: base, flexWon: 0, depth: 0, baseline: null, above: 0, worthy: worthyAt(list), total: list.length });
            return;
        }
        // A position shallower than its seats has no replacement to speak of, so its last player stands in.
        const baseline = list[Math.min(depth, list.length) - 1];
        out.push({
            pos, seats: base, flexWon: won.get(pos) || 0, depth, baseline,
            above: list.filter(v => v > baseline).length, worthy: worthyAt(list), total: list.length
        });
    });
    // Hardest seat first, by baseline. A position with no baseline sorts last.
    return out.sort((a, b) => {
        if (a.baseline === null || b.baseline === null) {
            return (a.baseline === null ? 1 : 0) - (b.baseline === null ? 1 : 0);
        }
        return b.baseline - a.baseline;
    });
}

/**
 * How many players either side of the replacement rank make up the level a group is priced
 * against.
 *
 * @type {number}
 */
export const REPLACEMENT_WINDOW = 2;

/**
 * The level of a replacement window: the mean of its players' scores.
 *
 * @param {?ReplacementWindow} entry The window.
 * @param {function(object): number} scoreOf A player's score.
 * @returns {number|undefined} Undefined when no player in it has a score.
 */
export function replacementScoreOf(entry, scoreOf) {
    const list = (entry && entry.players) || [];
    let sum = 0, n = 0;
    list.forEach(p => {
        const v = scoreOf(p);
        if (Number.isFinite(v)) { sum += v; n += 1; }
    });
    return n ? sum / n : undefined;
}

/**
 * What each seat group is priced against: the players around its replacement rank. A flex group
 * is priced from the players the named seats did not take.
 *
 * @param {object[]} ranked The players, best first, each with eligiblePositions.
 * @param {Array<{name: string, seats: number, accepts: Set<string>, flex: boolean}>} groups The seat
 *   groups.
 * @param {object} [options]
 * @param {number} [options.window] Players either side of the rank. Defaults to REPLACEMENT_WINDOW.
 * @returns {Map<string, ?ReplacementWindow>} The window by group name. Null for a group nobody can fill.
 */
export function replacementByGroup(ranked, groups, options = {}) {
    const out = new Map();
    // The option named window shadows the global inside this function, which is harmless in a pure module.
    const { window = REPLACEMENT_WINDOW } = options;
    const w = Math.max(0, Math.floor(Number(window)) || 0);
    const all = groups || [];
    const eligibleFor = (g, pool) => pool.filter(p => (p.eligiblePositions || []).some(v => g.accepts.has(v)));

    // A flex seat is priced last, from the players the named seats did not take. Players are claimed in the order the groups arrive, so one eligible at two named seats fills the first.
    const claimed = new Set();
    all.forEach(g => {
        if (!g || !g.name || !g.accepts || g.flex) return;
        const seats = Math.max(1, Math.floor(Number(g.seats) || 0));
        eligibleFor(g, (ranked || []).filter(p => !claimed.has(p.id))).slice(0, seats)
            .forEach(p => claimed.add(p.id));
    });

    all.forEach(g => {
        if (!g || !g.name || !g.accepts) return;
        const seats = Math.max(1, Math.floor(Number(g.seats) || 0));
        const mine = eligibleFor(g, g.flex ? (ranked || []).filter(p => !claimed.has(p.id)) : (ranked || []));
        // A group nobody can fill has no replacement rather than a fabricated one.
        if (!mine.length) { out.set(g.name, null); return; }
        // Shallower than its own seats, so the last player stands in.
        const index = Math.min(seats, mine.length) - 1;
        // A window running off the end of a shallow group keeps the players it can reach and borrows none from further away.
        out.set(g.name, windowAt(mine, index, w));
    });
    return out;
}

// The window itself, so the group-wide answer and a player's own answer are built by one function and cannot drift apart.
function windowAt(eligible, index, w) {
    const players = eligible.slice(Math.max(0, index - w), Math.min(eligible.length - 1, index + w) + 1);
    return {
        // The player at the rank itself, kept for a caller that wants one name.
        player: eligible[index],
        players,
        ids: players.map(p => p.id),
        window: w,
        index,
        // The group's eligible players in rank order, by reference, so a window for one player needs no second filter.
        eligible
    };
}

/**
 * A group's replacement window with one player left out, so no player is priced against a level
 * the same player is part of.
 *
 * @param {?ReplacementWindow} entry The group's window.
 * @param {number|string|null|undefined} excludeId The player being priced.
 * @returns {?ReplacementWindow} The window cut again without the player, or the entry itself when the
 *   player sits below it.
 */
export function replacementWindowFor(entry, excludeId) {
    if (!entry || excludeId === undefined || excludeId === null) return entry || null;
    const eligible = entry.eligible || [];
    const bottom = Math.min(eligible.length - 1, entry.index + entry.window);
    const pos = eligible.findIndex(p => String(p.id) === String(excludeId));
    if (pos < 0 || pos > bottom) return entry;
    const without = eligible.slice(0, pos).concat(eligible.slice(pos + 1));
    if (!without.length) return null;
    // The rank is found again on the shorter list, since a group shallower than its seats keeps its last player.
    const seats = entry.index + 1;
    return windowAt(without, Math.min(seats, without.length) - 1, entry.window);
}

/**
 * Which seat group prices a player: the cheapest seat the player could hold.
 *
 * @param {{eligiblePositions: string[]}} player The player.
 * @param {Array<{name: string, accepts: Set<string>}>} groups The seat groups.
 * @param {Map<string, ?ReplacementWindow>} replacements What replacementByGroup returned.
 * @param {function(ReplacementWindow): number} scoreOf A window's level.
 * @returns {?object} The group, or null when the player fits none that has a replacement.
 */
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

/**
 * The draft order as one list of team ids, pick 1 first.
 *
 * @param {Array<number|string>} pickOrder The first round's order.
 * @param {number} rounds The rounds.
 * @param {string} [type='SNAKE'] 'SNAKE' reverses every second round. Anything else repeats the order.
 * @returns {Array<number|string>}
 */
export function draftOrder(pickOrder, rounds, type = 'SNAKE') {
    const out = [];
    for (let r = 0; r < rounds; r++) {
        const row = (type === 'SNAKE' && r % 2 === 1) ? [...pickOrder].reverse() : pickOrder;
        out.push(...row);
    }
    return out;
}

/**
 * The overall pick numbers at which one team picks.
 *
 * @param {Array<number|string>} order The draft order.
 * @param {number|string} teamId The team.
 * @returns {number[]} The pick numbers, from one.
 */
export function picksFor(order, teamId) {
    const out = [];
    order.forEach((t, i) => { if (t === teamId) out.push(i + 1); });
    return out;
}

// ==== Scarcity ====

/**
 * How deep a position runs against the seats still to fill, as a ratio and a word.
 *
 * @param {number} available The players left who are worth starting.
 * @param {number} starters The seats.
 * @returns {{ratio: number, word: 'cliff'|'short'|'deep'|''}}
 */
export function scarcityOf(available, starters) {
    if (!(starters > 0)) return { ratio: Infinity, word: '' };
    const ratio = available / starters;
    if (ratio < 1) return { ratio, word: 'cliff' };
    if (ratio < 1.5) return { ratio, word: 'short' };
    if (ratio > 2) return { ratio, word: 'deep' };
    return { ratio, word: '' };
}

/**
 * A tone for each position, decided within the league. A position with fewer bodies than seats
 * is a cliff. Where none is, the single tightest position is short.
 *
 * @param {object[]} rows Rows carrying pos with either available and starters, or worthy and seats.
 * @returns {Array<{pos: string, available: number, starters: number, ratio: number,
 *   tone: 'cliff'|'short'|''}>} One row per position that has seats of its own.
 */
export function depthTones(rows) {
    const list = (rows || [])
        .map(r => {
            if (!r || !r.pos) return null;
            const starters = Number(r.starters !== undefined && r.starters !== null ? r.starters : r.seats) || 0;
            const availableRaw = r.available !== undefined && r.available !== null ? r.available : r.worthy;
            const available = Number(availableRaw) || 0;
            return starters > 0 ? { pos: r.pos, available, starters, ratio: available / starters } : null;
        })
        .filter(Boolean);
    if (!list.length) return [];
    const cliffs = list.filter(r => r.available < r.starters);
    let tightest = null;
    if (!cliffs.length) {
        tightest = list.slice().sort((a, b) =>
            (a.ratio - b.ratio) || (a.starters - b.starters) || a.pos.localeCompare(b.pos))[0];
    }
    return list.map(r => ({
        pos: r.pos,
        available: r.available,
        starters: r.starters,
        ratio: r.ratio,
        tone: r.available < r.starters ? 'cliff' : (tightest && r.pos === tightest.pos ? 'short' : '')
    }));
}

/**
 * Assigns each player to exactly one position, the eligible one the league is furthest from
 * filling, and counts the bodies at each.
 *
 * @param {Array<{player: {eligiblePositions: string[]}}>} players The players worth starting.
 * @param {Object<string, number>} jobsByPos The seats at each position.
 * @returns {Object<string, number>} The players assigned to each position.
 */
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

/**
 * Before a draft, how many players at each position are worth starting against the seats the
 * league opens there.
 *
 * @param {Array<{value: ?number, player: {eligiblePositions: string[]}}>} rows The board's rows.
 * @param {object} [options]
 * @param {Object<string, number>} [options.counts] How many of each lineup slot a team starts.
 * @param {Object<string, string>} [options.labels] The label of each slot.
 * @param {Set<number>} [options.bench] The slots that do not start.
 * @param {Set<number>} [options.flex] The slots that are flex seats.
 * @param {number} [options.teams] The league's size.
 * @returns {Array<{pos: string, starters: number, available: number, ratio: number, word: string}>} One
 *   row per position, tightest first.
 */
export function positionDepth(rows, { counts = {}, labels = {}, bench = new Set(), flex = new Set(), teams = 0 } = {}) {

    const jobs = new Map();
    Object.keys(counts).forEach(key => {
        const slot = Number(key);
        const n = Number(counts[key]) || 0;
        const label = labels[slot];
        // A flex seat is not a position anyone is short at, since it takes whoever is left. Which slots are flex arrives as data, and a caller that names none has none.
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

/**
 * A pseudo-random stream that replays exactly from its seed.
 *
 * @param {number} seed The seed.
 * @returns {function(): number} A function giving the next number, from 0 up to 1.
 */
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

/**
 * One pick by a bot. It prefers a player who fills an open seat, within a window at the top of
 * the list.
 *
 * @param {Array<{positions: string[]}>} candidates The players left, best first by consensus.
 * @param {Object<string, number>} needs The bot's open seats by position.
 * @param {number} variance How far down the window the bot reaches, from 0 to 1.
 * @param {function(): number} rand A random stream.
 * @param {object} [options]
 * @param {number} [options.window=6] The size of the window.
 * @returns {?object} The candidate taken, or null when there are none.
 */
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

/**
 * A mock draft before its first pick.
 *
 * @param {Array<number|string>} order The draft order.
 * @param {number} seed The seed the run replays from.
 * @returns {DraftState}
 */
export function initialDraftState(order, seed) {
    return { order: order || [], pickIndex: 0, rosters: {}, picks: [], seed: seed || 0 };
}

/**
 * Whether every pick has been made.
 *
 * @param {?DraftState} state The draft.
 * @returns {boolean}
 */
export function draftComplete(state) {
    return !state || state.pickIndex >= (state.order || []).length;
}

/**
 * The team whose pick it is.
 *
 * @param {?DraftState} state The draft.
 * @returns {number|string|null} The team id, or null when the draft is complete.
 */
export function teamOnClock(state) {
    if (draftComplete(state)) return null;
    return state.order[state.pickIndex];
}

/**
 * Makes one pick for the team on the clock.
 *
 * @param {DraftState} state The draft.
 * @param {number|string|null|undefined} playerId The player taken.
 * @returns {DraftState} A new state. The same state when there is no player or the draft is complete.
 */
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

/**
 * Runs picks until one team is on the clock or the draft ends.
 *
 * @param {DraftState} state The draft.
 * @param {number|string} teamId The team to stop at.
 * @param {function(DraftState): (number|string|null)} pickFor The player the team on the clock takes.
 * @returns {DraftState} The state reached. It stops early when a pick makes no progress.
 */
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

/**
 * A roster's open starting seats by position.
 *
 * @param {string[][]} rosterPositions One list of eligible positions per player already taken.
 * @param {Object<string, number>} slots How many of each position the team starts.
 * @returns {Object<string, number>} The open seats by position.
 */
export function openNeeds(rosterPositions, slots) {
    const need = {};
    Object.keys(slots || {}).forEach(pos => {
        const filled = (rosterPositions || []).filter(list => (list || []).indexOf(pos) !== -1).length;
        need[pos] = Math.max(0, (slots[pos] || 0) - filled);
    });
    return need;
}

// ==== What the room can say ====

/**
 * Whether one position has gone a set number of times in the most recent picks.
 *
 * @param {string[]} recentPositions The positions of the recent picks, oldest first.
 * @param {object} [options]
 * @param {number} [options.window=6] How many picks back to look.
 * @param {number} [options.threshold=4] How many of one position make a run.
 * @returns {?{position: string, count: number, of: number}} The run, or null.
 */
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

/**
 * Where a team stands in each category against the other teams: the share of them it is beating,
 * with a tie counted as half.
 *
 * @param {Object<string, Object<string, ?number>>} sumsByTeam Each team's figure in each category.
 * @param {number|string} teamId The team.
 * @param {string[]} categoryIds The categories.
 * @param {object} [options]
 * @param {Set<string>} [options.inverseIds] The categories won by the lower figure.
 * @returns {Array<{id: string, share: ?number, value: ?number}>} Per category. Share is null when the
 *   team has no figure or nobody to compare with.
 */
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
const COVERAGE_HOLE = 0.35;

/**
 * The categories a team is losing badly enough to call a hole.
 *
 * @param {Array<{id: string, share: ?number}>} coverage What coverageOf returned.
 * @param {number} [threshold] The share at or below which a category is a hole.
 * @returns {string[]} The category ids.
 */
export function holesFrom(coverage, threshold = COVERAGE_HOLE) {
    return (coverage || [])
        .filter(c => c && c.share !== null && c.share !== undefined && c.share <= threshold)
        .map(c => c.id);
}

/**
 * How many teams picking in a range of picks have an open seat at a position. A team is counted
 * once however often it picks.
 *
 * @param {Array<number|string>} order The draft order.
 * @param {number} fromIndex The first pick index, from zero.
 * @param {number} toIndex The pick index to stop before.
 * @param {Object<string, Object<string, number>>} needsByTeam Each team's open seats by position.
 * @param {string} position The position.
 * @returns {number}
 */
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

// A roster's figure in a rate category is rebuilt from the rate's components summed across the roster. Null when a component is missing or the denominator is zero, which is not a rate of zero.
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
    // A rate that is the sum of other rates, each derived first.
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

/**
 * A roster's figure in each category. A count is summed and a rate is rebuilt from its
 * components.
 *
 * @param {Array<Object<string, number>>} lines The roster's lines by stat id.
 * @param {string[]} categoryIds The categories.
 * @param {object[]} rateSpecs How each rate is derived from its components.
 * @returns {Object<string, ?number>} The figure by category. Null for a rate that cannot be derived.
 */
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

/**
 * A player's value across every group the player plays in. Only groups above replacement are
 * added, so a second skill adds or does nothing.
 *
 * @param {Array<?{percentiles: Map<string, number>, replacement: Map<string, number>}>} parts One part
 *   per group.
 * @param {object} [options]
 * @param {?Set<string>} [options.exclude] Categories shown and not priced.
 * @returns {?number} The value, or null when no part could be scored.
 */
export function sumOfEdgesAcross(parts, { exclude = null } = {}) {
    const scored = [];
    (parts || []).forEach(part => {
        if (!part) return;
        const s = sumOfEdges(part.percentiles, part.replacement, exclude);
        if (s !== null) scored.push(s);
    });
    if (!scored.length) return null;
    const positive = scored.filter(s => s > 0);
    return positive.length
        ? positive.reduce((a, b) => a + b, 0)
        : scored.reduce((a, b) => (b > a ? b : a));
}

// ==== A column that is mostly one number ====

/**
 * The filler value in a column that is mostly one number, such as average draft position out of
 * draft season.
 *
 * @param {number[]} values The column.
 * @param {object} [options]
 * @param {number} [options.share] The share of the column one value must exceed to be a filler.
 * @returns {?number} The filler value, or null when the column has none.
 */
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
