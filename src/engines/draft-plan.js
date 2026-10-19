/**
 * The draft planner's plan and the pick log, as one pure model: the plan and its rules, the log as an
 * undo stack, the board re-ranked as the pool shrinks, the plan's status against the log, and the
 * plan seated as a roster.
 *
 * Pure. No DOM, no application state, no network and no storage. Every operation returns a new
 * object and changes nothing it was handed. The order, the value arithmetic and the lineup figures
 * come from draft-engine.js and mock-lineup.js; this module owns the plan, the log and what lies
 * between them.
 *
 * Contract: tests/fixtures/draft-plan.md
 * Tests: tests/draft-plan.test.html
 * @module draft-plan
 */
/**
 * One rule on a round of the plan, beyond its alternates.
 *
 * @typedef {object} PlanRule
 * @property {('ifIHave'|'prefer'|'ifGone')} kind Which rule this is. An ifGone rule is never stored; rulesFor builds it from the alternates.
 * @property {number|string} [playerId] ifIHave: the player the team must already hold.
 * @property {number|string} [thenId] ifIHave: the player to take when it does.
 * @property {number|string} [aId] prefer: the player taken when both are there.
 * @property {number|string} [bId] prefer: the other player of the pair.
 * @property {Array<number|string>} [playerIds] ifGone: the alternates, in the reader's order.
 */
/**
 * One pick the reader owns, and who the reader means to take with it.
 *
 * @typedef {object} PlanRound
 * @property {number} round The reader's own round, from one.
 * @property {number} pick The overall pick number, the unit the log counts in.
 * @property {?(number|string)} targetId The player planned for the pick, or null.
 * @property {Array<number|string>} alternateIds The fallbacks, in the reader's own order.
 * @property {PlanRule[]} [rules] The round's stored rules.
 */
/**
 * A draft plan for one league.
 *
 * @typedef {object} DraftPlan
 * @property {?string} leagueKey The league the plan belongs to.
 * @property {?number} slot The reader's place in the first round, from one. Stored, never recomputed.
 * @property {PlanRound[]} rounds One row per pick the reader owns, in pick order.
 */
/**
 * The picks made so far, in draft order. Picks are appended at the end and removed from the end
 * only.
 *
 * @typedef {object} DraftLog
 * @property {Array<{overall: number, teamId: ?(number|string), playerId: (number|string)}>} picks Every logged pick.
 */
/**
 * The reader's notes, keyed by player.
 *
 * @typedef {object} PlayerNotes
 * @property {?string} leagueKey The league the notes belong to.
 * @property {Object<string, string>} notes The note text by player id.
 */
/**
 * A list of players placed on a lineup's seats.
 *
 * @typedef {object} Seating
 * @property {object} state mock-lineup.js's seat state after the last player.
 * @property {object} summary mock-lineup.js's summary of that state: total, ceiling and the rows per slot.
 * @property {Array<{playerId: (number|string), reason: string, round: (number|undefined)}>} unseated The players no seat accepted.
 */
import { picksFor, replacementByGroup, tierBreaks, tierOf, survivalWord, rosterTotals, coverageOf, openNeeds } from './draft-engine.js';
import { emptyState, seat, summary } from './mock-lineup.js';

// Ids are compared as strings throughout. ESPN's payloads carry a player id as a number in one place and a string in another, and a board that failed to cross a player off on that difference could not be trusted.
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined
    && String(a) === String(b);

// ==== 1. The plan ====

/**
 * Lays out an empty plan: one row per pick the team owns, in pick order.
 *
 * @param {?string} leagueKey The league the plan belongs to.
 * @param {Array<number|string>} order The team ids in pick order, one entry per overall pick.
 * @param {number|string} teamId The reader's team.
 * @param {object} [options]
 * @param {number} [options.slot] The reader's place in the first round, when the caller already knows it.
 * @returns {DraftPlan} The plan, every round with no target and no alternates.
 */
export function buildPlan(leagueKey, order, teamId, options = {}) {
    const picks = picksFor(order || [], teamId);
    const slot = options.slot !== undefined && options.slot !== null
        ? Number(options.slot)
        : ((order || []).findIndex(t => sameId(t, teamId)) + 1) || null;
    return {
        leagueKey: leagueKey ?? null,
        slot,
        rounds: picks.map((pick, i) => ({ round: i + 1, pick, targetId: null, alternateIds: [] }))
    };
}

// A round the plan does not carry is left alone, in every operation below. The round is gone, so the write has nowhere to land, and refusing would let a stale caller break the plan.
function mapRound(plan, round, fn) {
    if (!plan || !Array.isArray(plan.rounds)) return plan;
    if (!plan.rounds.some(r => r.round === round)) return plan;
    return { ...plan, rounds: plan.rounds.map(r => (r.round === round ? fn(r) : r)) };
}

/**
 * Sets the player planned for one round.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round to change. A round the plan does not carry changes nothing.
 * @param {?(number|string)} playerId The player, or null for none.
 * @returns {DraftPlan} A new plan.
 */
export function setTarget(plan, round, playerId) {
    return mapRound(plan, round, r => ({ ...r, targetId: playerId ?? null }));
}

/**
 * Sets one alternate of a round. Clearing an alternate closes the gap, so the one behind it moves
 * up.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round to change.
 * @param {number} index The alternate's place, from zero. A place past the end appends.
 * @param {?(number|string)} playerId The player, or null to remove the alternate at that place.
 * @returns {DraftPlan} A new plan, or the same plan for an index that is not a whole number from zero.
 */
export function setAlternate(plan, round, index, playerId) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return plan;
    return mapRound(plan, round, r => {
        const list = [...(r.alternateIds || [])];
        if (playerId === null || playerId === undefined) {
            if (i < list.length) list.splice(i, 1);
        } else if (i < list.length) {
            list[i] = playerId;
        } else {
            list.push(playerId);
        }
        return { ...r, alternateIds: list };
    });
}

/**
 * Clears a round's target and leaves its alternates as they are. No alternate is promoted, since
 * promotion follows from the log and not from the reader clearing a row.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round to clear.
 * @returns {DraftPlan} A new plan.
 */
export function removeTarget(plan, round) {
    return mapRound(plan, round, r => ({ ...r, targetId: null }));
}

// ==== 1a. The round's rules ====
const RULE_KINDS = ['ifGone', 'ifIHave', 'prefer'];

// The same kind over the same players is the same rule restated. A prefer rule matches on its pair either way round, so the plan never holds both halves of a contradiction.
function sameRule(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'ifIHave') return sameId(a.playerId, b.playerId);
    if (a.kind === 'prefer') {
        return (sameId(a.aId, b.aId) && sameId(a.bId, b.bId))
            || (sameId(a.aId, b.bId) && sameId(a.bId, b.aId));
    }
    return false;
}

function ruleIsWhole(rule) {
    if (!rule || !RULE_KINDS.includes(rule.kind)) return false;
    if (rule.kind === 'ifIHave') {
        return rule.playerId !== null && rule.playerId !== undefined
            && rule.thenId !== null && rule.thenId !== undefined;
    }
    if (rule.kind === 'prefer') {
        return rule.aId !== null && rule.aId !== undefined && rule.bId !== null && rule.bId !== undefined;
    }
    return false;   // ifGone is the alternates, never stored as a rule
}

/**
 * Adds a rule to a round, or replaces the rule it restates.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round the rule belongs to.
 * @param {PlanRule} rule An ifIHave or prefer rule with every player named.
 * @returns {DraftPlan} A new plan, or the same plan for a rule that is incomplete or of another kind.
 */
export function setRule(plan, round, rule) {
    if (!ruleIsWhole(rule)) return plan;
    return mapRound(plan, round, r => {
        const list = [...(r.rules || [])];
        const at = list.findIndex(existing => sameRule(existing, rule));
        if (at === -1) list.push({ ...rule });
        else list[at] = { ...rule };
        return { ...r, rules: list };
    });
}

/**
 * Removes one stored rule of a round, by its place among the stored rules. That is the place
 * rulesFor printed, less the ifGone entry at its head when the round has alternates.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round.
 * @param {number} index The rule's place among the round's stored rules, from zero.
 * @returns {DraftPlan} A new plan, or the same plan when there is no such rule.
 */
export function removeRule(plan, round, index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return plan;
    return mapRound(plan, round, r => {
        const list = [...(r.rules || [])];
        if (i >= list.length) return r;
        list.splice(i, 1);
        return { ...r, rules: list };
    });
}

/**
 * Every rule of a round as one list: the alternates first, as an ifGone rule, then the stored
 * rules in order.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round.
 * @returns {PlanRule[]} Copies of the rules. Empty for a round the plan does not carry.
 */
export function rulesFor(plan, round) {
    const row = ((plan && plan.rounds) || []).find(r => r && r.round === round);
    if (!row) return [];
    const alternates = (row.alternateIds || []).filter(id => id !== null && id !== undefined);
    const head = alternates.length ? [{ kind: 'ifGone', playerIds: alternates }] : [];
    return [...head, ...((row.rules || []).map(r => ({ ...r })))];
}

/**
 * Who a round takes, given who is off the board and who the team already holds. The one evaluator:
 * draft day, a rehearsal and a played-out plan all ask it, so they cannot answer differently.
 *
 * An ifIHave rule fires first, over a target that is still there. A prefer rule then settles its
 * pair, and the alternates are walked for whoever was chosen and is gone.
 *
 * @param {DraftPlan} plan The plan.
 * @param {number} round The round to resolve.
 * @param {object} [ctx]
 * @param {Array<number|string>} [ctx.goneIds] The players off the board.
 * @param {Array<number|string>} [ctx.heldIds] The players this team already holds.
 * @returns {{pick: ?(number|string), firedRule: ?PlanRule, reason: string, candidates: Array<number|string>}}
 *   The player to take or null, the rule that decided it, one of 'target', 'if-i-have', 'prefer',
 *   'if-gone' and 'nobody', and every player considered, in order.
 */
export function resolveRound(plan, round, ctx = {}) {
    const row = ((plan && plan.rounds) || []).find(r => r && r.round === round);
    if (!row) return { pick: null, firedRule: null, reason: 'nobody', candidates: [] };
    const gone = new Set(((ctx && ctx.goneIds) || []).map(String));
    const held = new Set(((ctx && ctx.heldIds) || []).map(String));
    const isGone = (id) => id === null || id === undefined || gone.has(String(id));
    const candidates = [];

    let pick = row.targetId ?? null;
    let firedRule = null;
    let reason = pick === null ? 'nobody' : 'target';

    const rules = row.rules || [];
    const haveRule = rules.find(r => r && r.kind === 'ifIHave' && held.has(String(r.playerId)));
    if (haveRule) {
        pick = haveRule.thenId;
        firedRule = { ...haveRule };
        reason = 'if-i-have';
    }

    // A prefer rule settles the pair it names, and only when the pick so far is one of them. It is a tie-break between two players the round is already choosing between.
    const preferRule = rules.find(r => r && r.kind === 'prefer'
        && (sameId(r.aId, pick) || sameId(r.bId, pick)));
    if (preferRule) {
        const aThere = !isGone(preferRule.aId);
        const bThere = !isGone(preferRule.bId);
        if (aThere && bThere && !sameId(pick, preferRule.aId)) {
            pick = preferRule.aId;
            firedRule = { ...preferRule };
            reason = 'prefer';
        } else if (!aThere && bThere && !sameId(pick, preferRule.bId)) {
            pick = preferRule.bId;
            firedRule = { ...preferRule };
            reason = 'prefer';
        }
    }

    if (pick !== null && pick !== undefined) candidates.push(pick);
    if (isGone(pick)) {
        const alternates = (row.alternateIds || []).filter(id => id !== null && id !== undefined);
        const next = alternates.find(id => !isGone(id));
        alternates.forEach(id => { if (!candidates.includes(id)) candidates.push(id); });
        if (next !== undefined) {
            pick = next;
            firedRule = { kind: 'ifGone', playerIds: alternates };
            reason = 'if-gone';
        } else {
            pick = null;
            reason = 'nobody';
        }
    }

    return { pick: pick ?? null, firedRule, reason, candidates };
}

/**
 * Reports what a reader can get wrong filling a plan by hand: a target in two rounds, an
 * alternate equal to its target, an alternate listed twice, a rule that changes nothing, and a rule
 * naming another round's target. It reports and never repairs.
 *
 * @param {DraftPlan} plan The plan.
 * @returns {{ok: boolean, problems: Array<{kind: string, playerId: (number|string), round: number, rounds: number[], index: number, indexes: number[], targetedIn: number}>}}
 *   Each problem carries its kind and player, and whichever of the other fields its kind uses.
 */
export function validate(plan) {
    const problems = [];
    const rounds = (plan && plan.rounds) || [];

    // Every round a target appears in is named, not only the later one, so the reader is not led to fix the wrong row.
    const byTarget = new Map();
    rounds.forEach(r => {
        if (r.targetId === null || r.targetId === undefined) return;
        const k = String(r.targetId);
        if (!byTarget.has(k)) byTarget.set(k, { playerId: r.targetId, rounds: [] });
        byTarget.get(k).rounds.push(r.round);
    });
    byTarget.forEach(v => {
        if (v.rounds.length > 1) {
            problems.push({ kind: 'duplicate-target', playerId: v.playerId, rounds: v.rounds });
        }
    });

    rounds.forEach(r => {
        const alts = r.alternateIds || [];
        alts.forEach((id, index) => {
            if (sameId(id, r.targetId)) {
                problems.push({ kind: 'alternate-equals-target', playerId: id, round: r.round, index });
            }
        });
        // The same player twice behind one target is reported here too, so the check is tested and does not live in a renderer.
        const seen = new Map();
        alts.forEach((id, index) => {
            const k = String(id);
            if (!seen.has(k)) seen.set(k, { playerId: id, indexes: [] });
            seen.get(k).indexes.push(index);
        });
        seen.forEach(v => {
            if (v.indexes.length > 1) {
                problems.push({
                    kind: 'duplicate-alternate', playerId: v.playerId, round: r.round,
                    indexes: v.indexes
                });
            }
        });
    });

    // The two mistakes a rule can carry: one that changes nothing, and one that would draft a player another round has already claimed. A prefer rule naming this round's own target is correct and is not reported.
    const targetRounds = new Map();
    rounds.forEach(r => {
        if (r.targetId === null || r.targetId === undefined) return;
        if (!targetRounds.has(String(r.targetId))) targetRounds.set(String(r.targetId), r.round);
    });
    rounds.forEach(r => {
        (r.rules || []).forEach(rule => {
            if (!rule) return;
            const picks = rule.kind === 'ifIHave' ? [rule.thenId]
                : rule.kind === 'prefer' ? [rule.aId, rule.bId] : [];
            if (rule.kind === 'ifIHave' && sameId(rule.thenId, r.targetId)) {
                problems.push({ kind: 'rule-equals-target', playerId: rule.thenId, round: r.round });
            }
            picks.forEach(id => {
                if (id === null || id === undefined) return;
                const at = targetRounds.get(String(id));
                if (at !== undefined && at !== r.round) {
                    problems.push({ kind: 'rule-player-targeted', playerId: id, round: r.round, targetedIn: at });
                }
            });
        });
    });

    return { ok: problems.length === 0, problems };
}

// ==== 1b. The reader's own notes ====

// A note is what the reader writes about a player. Nothing here knows about a round, a pick or a draft state, so a note outlives a rehearsal and the log. The cap exists because notes are stored per league in extension storage, where an unbounded field is a quota problem for every other note.
const NOTE_MAX = 1000;

/**
 * Starts a league's notes.
 *
 * @param {?string} leagueKey The league.
 * @returns {PlayerNotes} Notes holding nothing.
 */
export function emptyNotes(leagueKey) {
    return { leagueKey: leagueKey ?? null, notes: {} };
}

/**
 * Writes the reader's note on a player. An empty text removes the note, and a text over the cap is
 * cut, never refused.
 *
 * @param {?PlayerNotes} notes The notes so far.
 * @param {number|string} playerId The player.
 * @param {?string} text The note. It is trimmed and cut at 1,000 characters.
 * @returns {PlayerNotes} New notes. With no player, the notes as given.
 */
export function setNote(notes, playerId, text) {
    if (playerId === null || playerId === undefined) return notes || emptyNotes(null);
    const base = notes && notes.notes ? notes : emptyNotes(notes && notes.leagueKey);
    const next = { ...base.notes };
    const clean = String(text === null || text === undefined ? '' : text).trim().slice(0, NOTE_MAX);
    if (clean) next[String(playerId)] = clean;
    else delete next[String(playerId)];
    return { ...base, notes: next };
}

/**
 * Reads the note on a player.
 *
 * @param {?PlayerNotes} notes The notes.
 * @param {number|string} playerId The player.
 * @returns {?string} The note, or null when there is none.
 */
export function noteFor(notes, playerId) {
    if (!notes || !notes.notes || playerId === null || playerId === undefined) return null;
    return notes.notes[String(playerId)] || null;
}

/**
 * Lists the players that carry a note.
 *
 * @param {?PlayerNotes} notes The notes.
 * @returns {string[]} The player ids, as strings.
 */
export function notedIds(notes) {
    return Object.keys((notes && notes.notes) || {});
}

// ==== 2. The log ====

/**
 * Starts a pick log.
 *
 * @returns {DraftLog} A log with no picks.
 */
export function emptyLog() {
    return { picks: [] };
}

/**
 * Appends a pick to the log. A refusal returns the same log object, and the caller tests for it
 * by identity.
 *
 * A pick is refused when it names no player, when the player is already logged, and when its
 * overall number is not the next one. The sequence is what keeps every count of picks until the
 * reader's turn right.
 *
 * @param {DraftLog} log The log.
 * @param {{playerId: (number|string), teamId: ?(number|string), overall: ?number}} pick The pick. With no overall it takes the next one.
 * @returns {DraftLog} A new log with the pick appended, or the same object when refused.
 */
export function applyLoggedPick(log, pick) {
    if (!log || !Array.isArray(log.picks)) return log;
    if (!pick || pick.playerId === null || pick.playerId === undefined) return log;
    if (log.picks.some(p => sameId(p.playerId, pick.playerId))) return log;
    const overall = pick.overall === null || pick.overall === undefined
        ? log.picks.length + 1
        : Number(pick.overall);
    if (overall !== log.picks.length + 1) return log;
    return {
        ...log,
        picks: [...log.picks, {
            overall,
            teamId: pick.teamId ?? null,
            playerId: pick.playerId
        }]
    };
}

/**
 * Says why applyLoggedPick would refuse a pick, in words a page can print. It reads the same log
 * the call would, so it can be asked before logging or after a refusal.
 *
 * The team is not checked. A pick for any team, or for none, is accepted.
 *
 * @param {DraftLog} log The log.
 * @param {{playerId: (number|string), teamId: ?(number|string), overall: ?number}} pick The pick.
 * @returns {?{kind: string, reason: string}} Null when the pick would be accepted. Otherwise the kind,
 *   one of 'no-log', 'no-player', 'already-logged' and 'out-of-sequence', and a sentence.
 */
export function loggedPickRefusal(log, pick) {
    if (!log || !Array.isArray(log.picks)) {
        return { kind: 'no-log', reason: 'No draft log to add this pick to.' };
    }
    if (!pick || pick.playerId === null || pick.playerId === undefined) {
        return { kind: 'no-player', reason: 'Pick a player to log.' };
    }
    if (log.picks.some(p => sameId(p.playerId, pick.playerId))) {
        const held = log.picks.find(p => sameId(p.playerId, pick.playerId));
        return { kind: 'already-logged', reason: `Already logged at pick ${held.overall}.` };
    }
    const next = log.picks.length + 1;
    const overall = pick.overall === null || pick.overall === undefined ? next : Number(pick.overall);
    if (overall !== next) {
        return { kind: 'out-of-sequence', reason: `Pick ${next} is next. Undo back to ${overall} to change it.` };
    }
    return null;
}

/**
 * Removes the last pick from the log.
 *
 * @param {DraftLog} log The log.
 * @returns {DraftLog} A new log one pick shorter, or the same object when there is nothing to undo.
 */
export function undoLastPick(log) {
    if (!log || !Array.isArray(log.picks) || !log.picks.length) return log;
    return { ...log, picks: log.picks.slice(0, -1) };
}

/**
 * Groups the log's picks by team, each team's players in the order they were taken. A pick with no
 * team is kept apart, never dropped.
 *
 * @param {DraftLog} log The log.
 * @returns {{byTeam: Object<string, Array<number|string>>, unassigned: Array<number|string>}}
 *   The player ids by team id, and the players logged with no team.
 */
export function rostersFromLog(log) {
    const byTeam = {};
    const unassigned = [];
    ((log && log.picks) || []).forEach(p => {
        if (!p || p.playerId === null || p.playerId === undefined) return;
        if (p.teamId === null || p.teamId === undefined) { unassigned.push(p.playerId); return; }
        const key = String(p.teamId);
        if (!byTeam[key]) byTeam[key] = [];
        byTeam[key].push(p.playerId);
    });
    return { byTeam, unassigned };
}

/**
 * A team's category coverage off the log, through the same draft-engine.js calls a rehearsal uses:
 * each team's projected lines summed, then one team read against the rest.
 *
 * @param {DraftLog} log The log.
 * @param {object} [options]
 * @param {number|string} [options.teamId] The team to read.
 * @param {Array<number|string>} [options.teamIds] Every team in the league, so one that has not picked still counts. Defaults to the teams in the log.
 * @param {Array<number|string>} [options.categoryIds] The scored categories.
 * @param {function((number|string)): ?object} [options.lineOf] A player's projected line by stat id.
 * @param {object[]} [options.rateSpecs] How each rate category is rebuilt from its components.
 * @param {Set} [options.inverseIds] The categories where lower is better.
 * @returns {*} draft-engine.js's coverageOf result for the team.
 */
export function logCoverage(log, {
    teamId = null, teamIds = [], categoryIds = [], lineOf = null, rateSpecs = [], inverseIds = null
} = {}) {
    const { byTeam } = rostersFromLog(log);
    const ids = (teamIds && teamIds.length) ? teamIds : Object.keys(byTeam);
    const sums = {};
    ids.forEach(t => {
        const lines = (byTeam[String(t)] || []).map(id => (typeof lineOf === 'function' ? lineOf(id) : null) || {});
        sums[t] = rosterTotals(lines, categoryIds, rateSpecs);
    });
    return coverageOf(sums, teamId, categoryIds, { inverseIds: inverseIds || new Set() });
}

/**
 * What a team still needs, off the log, in draft-engine.js's openNeeds shape.
 *
 * @param {DraftLog} log The log.
 * @param {number|string} teamId The team.
 * @param {object} [options]
 * @param {function((number|string)): ?Array} [options.positionsOf] A drafted player's eligible positions.
 * @param {object} [options.slots] The league's roster slots and how many of each.
 * @returns {*} draft-engine.js's openNeeds result.
 */
export function logNeeds(log, teamId, { positionsOf = null, slots = {} } = {}) {
    const { byTeam } = rostersFromLog(log);
    const held = byTeam[String(teamId)] || [];
    const positions = held.map(id => (typeof positionsOf === 'function' ? positionsOf(id) : null) || []);
    return openNeeds(positions, slots);
}

// One board carries three switches: Plan, Rehearse and Log picks. Plan is independent. Rehearse and Log picks exclude each other, since one is an invented draft and the other the real one. The date rule fires once and never overrides the reader, and today means the reader's own calendar day.
function sameLocalDay(a, b) {
    const x = new Date(Number(a)), y = new Date(Number(b));
    if (!Number.isFinite(x.getTime()) || !Number.isFinite(y.getTime())) return false;
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Decides which of the board's three switches are on, after an optional request and the draft-day
 * rule.
 *
 * Rehearse is refused while the log holds a pick, with a reason to print. On the draft's own
 * calendar day Log picks turns on once, before the request is read.
 *
 * @param {{plan: boolean, rehearse: boolean, log: boolean}} [current] The switches as they stand.
 * @param {object} [facts]
 * @param {{name: ('plan'|'rehearse'|'log'), on: boolean}} [facts.request] The switch the reader pressed.
 * @param {number} [facts.draftDate] The draft's time in epoch milliseconds, when the league has one.
 * @param {number} [facts.now] The present, in epoch milliseconds.
 * @param {number} [facts.loggedPicks=0] How many picks the log holds.
 * @param {boolean} [facts.autoApplied=false] Whether the draft-day rule has already fired.
 * @returns {{plan: boolean, rehearse: boolean, log: boolean, autoApplied: boolean, refused: ?{name: string, reason: string}}}
 *   The switches, whether the draft-day rule has now fired, and the refusal if the request was one.
 */
export function resolveDraftSwitches(current = {}, facts = {}) {
    const state = {
        plan: !!(current && current.plan),
        rehearse: !!(current && current.rehearse),
        log: !!(current && current.log)
    };
    const { request = null, draftDate = null, now = Date.now(), loggedPicks = 0, autoApplied = false } = facts || {};
    let applied = !!autoApplied;
    let refused = null;

    // The date rule runs before the request, so a reader who opens the tab on draft day and turns Log picks off gets what was asked for.
    if (!applied && draftDate !== null && draftDate !== undefined && sameLocalDay(draftDate, now)) {
        applied = true;
        state.log = true;
        state.rehearse = false;
    }

    if (request && request.name) {
        const on = !!request.on;
        if (request.name === 'plan') {
            state.plan = on;
        } else if (request.name === 'rehearse') {
            if (on && Number(loggedPicks) > 0) {
                refused = {
                    name: 'rehearse',
                    reason: `Log picks holds ${loggedPicks} ${Number(loggedPicks) === 1 ? 'pick' : 'picks'}. Undo them to rehearse.`
                };
            } else {
                state.rehearse = on;
                if (on) state.log = false;
            }
        } else if (request.name === 'log') {
            state.log = on;
            if (on) state.rehearse = false;
        }
    }

    return { ...state, autoApplied: applied, refused };
}

// ==== 3. The board for this pick ====

/**
 * The players the log has not taken.
 *
 * @param {Array<{id: (number|string)}>} pool The pool.
 * @param {DraftLog} log The log.
 * @returns {object[]} The pool's players not in the log, in the pool's order.
 */
export function remainingPool(pool, log) {
    const gone = new Set(((log && log.picks) || []).map(p => String(p.playerId)));
    return (pool || []).filter(p => p && !gone.has(String(p.id)));
}

/**
 * Re-ranks what is left of the pool and re-cuts the tiers and the replacement level on it. When
 * the top of a position goes, the players behind it are worth more against a lower replacement.
 *
 * @param {object[]} remaining The players still available.
 * @param {object[]} groups The seat groups the replacement level is priced over.
 * @param {object} [options]
 * @param {function(object): number} [options.scoreOf] A player's value. Defaults to the player's own value field.
 * @param {number} [options.minGap] The drop in value that opens a new tier.
 * @param {number} [options.maxSize] The most players one tier holds.
 * @param {number} [options.window] How far either side of the replacement rank the level reaches.
 * @returns {{ranked: object[], replacements: Object<string, ?(number|string)>, replacementWindow: Object<string, ?Array>, breaks: number[], tierById: Object<string, number>}}
 *   The players best first with their value, the replacement player's id per group, the ids in each
 *   group's window, where the tiers break, and each player's tier.
 */
export function rerank(remaining, groups, options = {}) {
    const { scoreOf = null, minGap, maxSize } = options;
    const score = typeof scoreOf === 'function' ? scoreOf : (p => Number(p && p.value));
    const ranked = (remaining || [])
        .map(p => ({ ...p, value: Number(score(p)) }))
        .filter(p => Number.isFinite(p.value))
        .sort((a, b) => b.value - a.value);

    const breakOpts = {};
    if (minGap !== undefined) breakOpts.minGap = minGap;
    if (maxSize !== undefined) breakOpts.maxSize = maxSize;
    const breaks = tierBreaks(ranked, breakOpts);

    // Flattened to ids, the form every other part of this chain uses. The replacement stays the player on the replacement rank, and the window carries the whole level beside it.
    const replacements = {};
    const replacementWindow = {};
    replacementByGroup(ranked, groups || [], { window: options.window }).forEach((entry, name) => {
        replacements[name] = entry && entry.player ? entry.player.id : null;
        replacementWindow[name] = entry ? entry.ids : null;
    });

    // The tier is worked out once per player here, so a renderer never indexes the breaks itself.
    const tierById = {};
    ranked.forEach((p, i) => { tierById[String(p.id)] = tierOf(i, breaks); });

    return { ranked, replacements, replacementWindow, breaks, tierById };
}

// ==== 4. The plan against the log ====

// The reader's team is read from the order at the plan's own slot unless the caller names one, since that is what a slot means.
function readerTeam(plan, order, options) {
    if (options && options.myTeamId !== undefined && options.myTeamId !== null) return options.myTeamId;
    const slot = Number(plan && plan.slot);
    if (!Number.isInteger(slot) || slot < 1) return null;
    return (order || [])[slot - 1] ?? null;
}

/**
 * Each round of the plan read against the log. A status is 'mine' when the reader took the target,
 * 'taken' when another team did, and 'open' when the target is not in the log. Open does not mean
 * the player will last to the pick.
 *
 * @param {DraftPlan} plan The plan.
 * @param {DraftLog} log The log.
 * @param {Array<number|string>} order The team ids in pick order.
 * @param {object} [options]
 * @param {number|string} [options.myTeamId] The reader's team, when the caller names it.
 * @returns {Array<{round: number, pick: number, targetId: ?(number|string), status: string, takenAt: ?{overall: number, teamId: ?(number|string)}, promotedId: ?(number|string), reason: ?string}>}
 *   One row per round. A taken target carries the first alternate still free, or a reason when
 *   there is none.
 */
export function planStatus(plan, log, order, options = {}) {
    const picks = (log && log.picks) || [];
    const myTeamId = readerTeam(plan, order, options);
    const takenBy = new Map();
    picks.forEach(p => { takenBy.set(String(p.playerId), p); });

    return ((plan && plan.rounds) || []).map(r => {
        const row = {
            round: r.round, pick: r.pick, targetId: r.targetId ?? null,
            status: 'open', takenAt: null, promotedId: null, reason: null
        };
        // A row with no target is not a problem and gets no reason.
        if (row.targetId === null) return row;

        const hit = takenBy.get(String(row.targetId));
        if (!hit) return row;

        row.takenAt = { overall: hit.overall, teamId: hit.teamId ?? null };
        if (myTeamId !== null && sameId(hit.teamId, myTeamId)) {
            row.status = 'mine';
            return row;
        }
        row.status = 'taken';

        // The alternates are walked in the reader's own order and never re-sorted by value, since that order is the reader's ranking.
        const alts = (r.alternateIds || []).filter(id => id !== null && id !== undefined);
        const free = alts.find(id => !takenBy.has(String(id)));
        if (free !== undefined) {
            row.promotedId = free;
            return row;
        }
        // A row that promoted nobody says why.
        row.reason = alts.length ? 'Every alternate is gone too.' : 'No alternate was listed.';
        return row;
    });
}

// ==== 5. Where the draft is ====

/**
 * Where the draft stands: the pick on the clock and how far off the reader's next one is. Zero
 * picks away means the reader is on the clock.
 *
 * @param {Array<number|string>} order The team ids in pick order, one entry per overall pick.
 * @param {DraftLog} log The log.
 * @param {number|string} myTeamId The reader's team.
 * @returns {?{overall: number, teamId: ?(number|string), myNextOverall: ?number, untilMine: ?number}}
 *   Null once every pick is made. The last two are null when the reader has no pick left.
 */
export function nextPick(order, log, myTeamId) {
    const list = order || [];
    const overall = (((log && log.picks) || []).length) + 1;
    if (overall > list.length) return null;
    const mine = picksFor(list, myTeamId).find(p => p >= overall);
    return {
        overall,
        teamId: list[overall - 1] ?? null,
        myNextOverall: mine ?? null,
        untilMine: mine === undefined ? null : mine - overall
    };
}

// ==== 6. The plan as a roster ====

// One seating rule for a plan, a log and a rehearsal. Players are seated in the order they arrive, each in the first empty seat that accepts it, through mock-lineup.js's own seat, which returns the same state when it refuses. A player no seat accepts is reported, never dropped. The figures are mock-lineup.js's summary, not a second computation.
function seatInOrder(entries, pool, seats, ctx = {}) {
    let state = emptyState(seats || []);
    const unseated = [];
    (entries || []).forEach(entry => {
        const playerId = entry && entry.playerId;
        if (playerId === null || playerId === undefined) return;
        let placed = false;
        for (let i = 0; i < state.seats.length; i++) {
            if (state.seats[i].playerId !== null && state.seats[i].playerId !== undefined) continue;
            const next = seat(state, playerId, i, pool, ctx);
            if (next !== state) { state = next; placed = true; break; }
        }
        if (!placed) {
            const row = { playerId, reason: 'No seat accepts this player.' };
            if (entry.round !== undefined) row.round = entry.round;
            unseated.push(row);
        }
    });
    return { state, summary: summary(state, pool, null, ctx), unseated };
}

/**
 * Seats a list of players on a lineup, in the order given.
 *
 * @param {Array<number|string>} playerIds The players, in the order they were taken.
 * @param {object[]} pool The player pool mock-lineup.js reads.
 * @param {object[]} seats The lineup's seats, from mock-lineup.js's seatsFor.
 * @param {object} [ctx] Passed through to mock-lineup.js.
 * @returns {Seating} The seated lineup and the players no seat accepted.
 */
export function seatAll(playerIds, pool, seats, ctx = {}) {
    return seatInOrder((playerIds || []).map(playerId => ({ playerId })), pool, seats, ctx);
}

/**
 * Seats one team's logged picks on a lineup.
 *
 * @param {DraftLog} log The log.
 * @param {number|string} teamId The team.
 * @param {object[]} pool The player pool mock-lineup.js reads.
 * @param {object[]} seats The lineup's seats.
 * @param {object} [ctx] Passed through to mock-lineup.js.
 * @returns {Seating} The seated lineup and the players no seat accepted.
 */
export function logSeats(log, teamId, pool, seats, ctx = {}) {
    const { byTeam } = rostersFromLog(log);
    return seatAll(byTeam[String(teamId)] || [], pool, seats, ctx);
}

/**
 * Seats the plan's targets on a lineup, in pick order.
 *
 * @param {DraftPlan} plan The plan.
 * @param {object[]} pool The player pool mock-lineup.js reads.
 * @param {object[]} seats The lineup's seats.
 * @param {object} [ctx] Passed through to mock-lineup.js.
 * @returns {Seating} The seated lineup. An unseated target carries its round.
 */
export function planRoster(plan, pool, seats, ctx = {}) {
    const entries = ((plan && plan.rounds) || [])
        .filter(r => r && r.targetId !== null && r.targetId !== undefined)
        .map(r => ({ playerId: r.targetId, round: r.round }));
    return seatInOrder(entries, pool, seats, ctx);
}

// ==== 7. Value over the next pick ====

/**
 * The survival words that count as still there at the reader's next pick. They are
 * draft-engine.js's own words for a player the crowd takes after that pick.
 *
 * @type {string[]}
 */
export const SURVIVES_TO_NEXT = ['likely', 'coin flip'];

/**
 * What each player is worth over waiting: the player's value less that of the best other player at
 * the same seat who is expected to last to the reader's next pick.
 *
 * A player is never compared with itself. Each row carries the player's own survival word as well,
 * since being worth more than the next one and being likely to last are two separate facts.
 *
 * @param {Array<{id: (number|string), value: number}>} remaining The players still available, best first.
 * @param {number} myNextOverall The reader's next overall pick.
 * @param {object} [options]
 * @param {function(object): *} [options.groupOf] The seat group that prices a player: a name, or an object with a name.
 * @param {number} [options.currentPick] The pick on the clock.
 * @param {function(object): number} [options.adpOf] A player's average draft position.
 * @param {string[]} [options.survives] The survival words that count as lasting.
 * @returns {{rows: Array<{id: (number|string), group: ?string, value: number, survives: string, overNext: ?number, bestAtNextId: ?(number|string), reason: ?string}>, bestAtNext: Object<string, ?{id: (number|string), value: number}>}}
 *   One row per player, with a reason where no figure can be given, and the best survivor per
 *   group.
 */
export function valueOverNext(remaining, myNextOverall, options = {}) {
    const {
        groupOf = null, currentPick = null, adpOf = (p => p && p.adp),
        survives = SURVIVES_TO_NEXT
    } = options;
    const list = (remaining || []).filter(p => p && Number.isFinite(Number(p.value)));
    const words = new Map();
    const wordFor = (p) => {
        const k = String(p.id);
        if (!words.has(k)) {
            words.set(k, survivalWord(Number(adpOf(p)) || 0, Number(myNextOverall) || 0, Number(currentPick) || 0));
        }
        return words.get(k);
    };

    // Grouped once, each group in the order it arrived, which is the board's own value order. The best that survives is then a scan, with no second sort and no second tie rule.
    const byGroup = new Map();
    const groupNames = new Map();
    list.forEach(p => {
        const g = groupOf ? groupOf(p) : null;
        const name = g && g.name !== undefined ? g.name : g;
        groupNames.set(String(p.id), name ?? null);
        if (name === null || name === undefined) return;
        if (!byGroup.has(name)) byGroup.set(name, []);
        byGroup.get(name).push(p);
    });

    const bestAtNext = {};
    byGroup.forEach((members, name) => {
        const best = members.find(p => survives.includes(wordFor(p)));
        bestAtNext[name] = best ? { id: best.id, value: Number(best.value) } : null;
    });

    const rows = list.map(p => {
        const name = groupNames.get(String(p.id));
        const word = wordFor(p);
        const row = {
            id: p.id, group: name ?? null, value: Number(p.value), survives: word,
            overNext: null, bestAtNextId: null, reason: null
        };
        if (name === null || name === undefined) {
            // No seat prices this player, so there is nothing to measure against.
            row.reason = 'No seat prices this player.';
            return row;
        }
        const alternative = (byGroup.get(name) || [])
            .find(q => !sameId(q.id, p.id) && survives.includes(wordFor(q)));
        if (!alternative) {
            // The whole position is at risk, which is its own fact and not a zero. A zero would read as no better than waiting, when waiting gets nothing.
            row.reason = 'Nothing else at this position is likely to last.';
            return row;
        }
        row.bestAtNextId = alternative.id;
        row.overNext = Number(p.value) - Number(alternative.value);
        return row;
    });

    return { rows, bestAtNext };
}

// ==== 8. The suggestion ====

/**
 * Who the board offers for one empty round, and on what basis. The basis is 'survives' when a
 * draft position decided it and 'value' when none could, and a 'value' offer says which of two
 * reasons applies.
 *
 * @param {Array<{id: (number|string)}>} candidates The players to choose from, best first, less anyone the plan names.
 * @param {number} pick The overall pick the round falls on.
 * @param {object} [options]
 * @param {number} [options.currentPick=1] The pick on the clock.
 * @param {function(object): number} [options.adpOf] A player's average draft position.
 * @param {string[]} [options.survives] The survival words that count as lasting.
 * @returns {?{id: (number|string), basis: ('survives'|'value'), reason: ?string}} The offer, or null with nobody to offer.
 */
export function suggestFor(candidates, pick, options = {}) {
    const {
        currentPick = 1, adpOf = (p => p && p.adp), survives = SURVIVES_TO_NEXT
    } = options;
    const list = (candidates || []).filter(p => p && p.id !== undefined && p.id !== null);
    if (!list.length) return null;

    const adpOfRow = (p) => {
        const v = Number(adpOf(p));
        return Number.isFinite(v) && v > 0 ? v : null;
    };
    const anyAdp = list.some(p => adpOfRow(p) !== null);

    if (anyAdp) {
        const held = list.find(p => {
            const adp = adpOfRow(p);
            return adp !== null && survives.includes(survivalWord(adp, Number(pick) || 0, Number(currentPick) || 0));
        });
        if (held) return { id: held.id, basis: 'survives', reason: null };
        // Draft positions exist and nobody is expected to last, which is a fact about the players.
        return { id: list[0].id, basis: 'value', reason: 'Nothing at this pick is likely to last.' };
    }

    // No draft position anywhere in the league, so survival cannot be asked. The best player left is still the offer, and the reason says it was not weighed against who else will be there.
    return { id: list[0].id, basis: 'value', reason: 'No draft positions published for this league.' };
}

/**
 * The suggestions for a whole plan, with no player offered to two rounds. The rounds are walked
 * in pick order, and each empty one asks suggestFor over the pool less every player the plan names
 * elsewhere and every player an earlier round was offered.
 *
 * @param {PlanRound[]} rounds The plan's rounds, in any order.
 * @param {Array<{id: (number|string)}>} pool The players, best first.
 * @param {object} [options] Passed to suggestFor.
 * @returns {Array<{round: number, pick: number, suggestion: ?{id: (number|string), basis: string, reason: ?string}}>}
 *   One row per round in the order given. A round with a target is offered nobody.
 */
export function suggestPlan(rounds, pool, options = {}) {
    const list = (rounds || []).filter(r => r && Number.isFinite(Number(r.pick)));
    const idsOf = (r) => [r.targetId, ...(r.alternateIds || [])]
        .filter(id => id !== null && id !== undefined).map(String);
    const offered = new Set();
    const byRound = new Map();
    [...list].sort((a, b) => Number(a.pick) - Number(b.pick)).forEach(r => {
        if (r.targetId !== null && r.targetId !== undefined) { byRound.set(r, null); return; }
        const own = new Set(idsOf(r));
        const spoken = new Set(list.filter(x => x !== r).flatMap(idsOf));
        const candidates = (pool || []).filter(p => {
            if (!p || p.id === null || p.id === undefined) return false;
            const id = String(p.id);
            return !offered.has(id) && (own.has(id) || !spoken.has(id));
        });
        const suggestion = suggestFor(candidates, r.pick, options);
        if (suggestion) offered.add(String(suggestion.id));
        byRound.set(r, suggestion);
    });
    return list.map(r => ({ round: r.round, pick: Number(r.pick), suggestion: byRound.get(r) }));
}

/**
 * Whether the log in memory survives a reset. It does when the reset is for the league the log was
 * loaded for, since fetching the same league again is not a change of league.
 *
 * @param {?string} loadedForKey The league key the log in memory was loaded for.
 * @param {?string} nextKey The league key now being loaded.
 * @returns {boolean} True when both keys are present and equal.
 */
export function logSurvivesReset(loadedForKey, nextKey) {
    if (loadedForKey === null || loadedForKey === undefined) return false;
    if (nextKey === null || nextKey === undefined) return false;
    return String(loadedForKey) === String(nextKey);
}

/**
 * Whether a log read from storage may replace the one in memory. Only when memory holds no picks:
 * every change is saved as it happens, so a log in memory is never older than the stored one.
 *
 * @param {?DraftLog} memory The log in memory.
 * @param {?DraftLog} stored The log read from storage.
 * @returns {boolean} True when the stored log is a log and memory is empty.
 */
export function storedLogApplies(memory, stored) {
    if (!stored || !Array.isArray(stored.picks)) return false;
    const held = (memory && Array.isArray(memory.picks)) ? memory.picks.length : 0;
    return held === 0;
}

/**
 * Whether to offer to clear picks that came from a draft room. Only for picks merged in from
 * another league's room. A closed room of this league is not a reason, since a dropped connection
 * looks the same and those picks are this league's real draft.
 *
 * @param {object} [facts]
 * @param {boolean} [facts.isRehearse=false] Whether a rehearsal is on.
 * @param {boolean} [facts.roomActive=false] Whether a room is open now.
 * @param {boolean} [facts.foreign=false] Whether the room's picks belong to another league. False when that cannot be told.
 * @param {boolean} [facts.hasRoomPicks=false] Whether the log holds picks from a room.
 * @returns {boolean} True when the offer should be made.
 */
export function roomPicksClearOffer({ isRehearse = false, roomActive = false, foreign = false, hasRoomPicks = false } = {}) {
    if (isRehearse) return false;
    if (roomActive) return false;      // a live room's picks stay off limits, as Undo already has it
    if (!hasRoomPicks) return false;
    return foreign === true;
}
