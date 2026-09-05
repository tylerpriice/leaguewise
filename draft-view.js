import {
    AppState, ESPN_STAT_MAPS, AVERAGE_STATS, INVERSE_STATS, SECONDARY_GROUP_POSITIONS, RATE_COMPONENTS,
    NON_STARTING_SLOTS, SECONDARY_LINEUP_SLOTS, LINEUP_SLOT_LABELS, LINEUP_SLOT_ORDER, FLEX_SLOTS
} from './state.js';
import { findOwnedTeamId } from './utils.js';
import { currentProSchedule } from './api.js';
import { openExportModal, registerExportDataset } from './export.js';
import {
    computeGroupRanks, matchesPlayerGroup, positionOptionsFor, formatStatValue,
    buildBoard, leagueStarters, estimateSplit, unprojectedCategoryIds, hasProjection, adpOf, adpFiller,
    playoffDensityRows
} from './players.js';
import {
    adpVerdict, startingSlotsByGroup, replacementLevel, estimateUnprojected,
    tierBreaks, tierOf, scarcityOf, assignBodies, positionDepth, sumOfEdges, sumOfEdgesAcross, degenerateValue,
    survivalWord, draftOrder, botPick, seededRandom,
    initialDraftState, applyPick, draftComplete, teamOnClock, simToTeam, openNeeds,
    runDetect, coverageOf, holesFrom, threatCount, rosterTotals
} from './draft-engine.js';
import { GAMES_PLAYED_IDS } from './rank-engine.js';
import { escapeHtml, percentileVar, injuryBadgeHtml } from './utils.js';
import { buildPlayerAvatarHtml, wirePlayerAvatars, initialsFor } from './images.js';
import { buildProTeamAbbrevs } from './probables.js';
import { teamDensity } from './schedule-insight.js';

// THE PRO CLUB'S ABBREVIATION, when the app already has it. It rides the pro-team schedule, which My Team and the day-axis chart fetch and cache. The draft tab asks for nothing: when that response is already in hand every row names its club, and when it is not the rows do not. A three-letter label is not worth a request.
function proTeamAbbrevs() {
    // Through the accessor, which answers with the body or with nothing. Reading the store directly cost this surface twice: handing the { key, data } WRAPPER to a function that reads.settings.proTeams returns an empty map silently - measured at 33 abbreviations the right way against 0 the wrong one, which is why no club ever appeared on a draft row even with the response in hand - and reading.data without checking the key prints another sport's abbreviation for the same numeric club id. The accessor closes both.
    const data = currentProSchedule();
    return data ? buildProTeamAbbrevs(data) : new Map();
}

// ==== How busy a player's club is in the league's own playoff matchups ====

// A DRAFT DECISION THE BOARD COULD NOT ANSWER. Two players can be a coin flip on value and not on schedule: a club playing four games in a playoff round produces twice what a club playing two does, and until now nothing on this board said so. It asks for NOTHING. The pro-team schedule is fetched by My Team and the day-axis chart and cached in AppState; when it is there every row can be hovered, and when it is not the rows are exactly as they were. A schedule is not worth a request from a draft board. Memoised on the league payload and the cached schedule together, because the alternative is walking 32 clubs' seasons once per row for three thousand rows. "Playoff matchups. Tor plays 3 games in 22, 3 in 23, and 8 in 24. Those rounds run 7, 7, and 18 days." Counts and the league's own matchup numbers, nothing else. No percentage, no rating, and no word like "favourable" - how many games a club plays is a fact, and whether that is good depends on who else the reader is choosing between, which the board cannot know. THE SECOND SENTENCE IS NOT DECORATION, and the real league is what proved it. ESPN folds the tail of the pro season into the final round: measured on the owner's own hockey league, matchups 22 and 23 run 7 days each and matchup 24 runs EIGHTEEN. A club reading "8 in 24" against "4 in 22" is less busy per day, not twice as busy, so a bare list of counts says the opposite of the truth. The lengths ride along whenever the rounds differ, and are left off when they do not, because "7, 7, and 7 days" is noise. It is the same rule the schedule-insight contract states for start counts - a count is only comparable within rounds of equal length - arriving on the first surface to read one. A BYE READS AS "NONE", which is the single most useful thing this line can say. The club name is dropped rather than guessed at when the abbreviation is missing.
function playoffHoverFor(player, clubs) {
    const rows = playoffDensityRows();
    if (!rows || !rows.length || player.proTeamId === undefined || player.proTeamId === null) return '';
    // A FREE AGENT HAS NO CLUB, which is not the same as a club with no games. ESPN gives them proTeamId 0 and the density map deliberately has no row for it, so "FA plays no games in 22" would read as a scheduling fact about a club that does not exist. Say nothing instead.
    if (!rows[0].byTeam.has(Number(player.proTeamId))) return '';
    const line = teamDensity(rows, player.proTeamId);
    if (!line.length) return '';
    // Oxford comma, per VOICE. Two rounds read "a and b", three or more "a, b, and c".
    const oxford = parts => (parts.length > 2
        ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
        : parts.join(' and '));
    const games = oxford(line.map((r, i) => {
        const n = i === 0
            ? (r.games === 0 ? 'no games' : `${r.games} game${r.games === 1 ? '' : 's'}`)
            : (r.games === 0 ? 'none' : String(r.games));
        return `${n} in ${r.matchup}`;
    }));
    const club = clubs.get(Number(player.proTeamId));
    const lengths = rows.map(r => r.periods);
    const uneven = lengths.some(d => d !== lengths[0]);
    const days = uneven ? ` Those rounds run ${oxford(lengths.map(String))} days.` : '';
    return `Playoff matchups. ${club ? `${club} plays ` : ''}${games}.${days}`;
}

// "82nd percentile" reads as a measured fact; "82%" reads as a probability, which it is not.
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// A character code rather than an escape. An edit script doubled the backslash on this exact separator once already, which shipped the literal six characters into a label.
const MIDDOT = String.fromCharCode(183);
const DASH = String.fromCharCode(8212);
const STAR_ON = String.fromCharCode(9733);
const STAR_OFF = String.fromCharCode(9734);

// WHERE A CATEGORY COUNTS AS A STRENGTH, for the one sentence that still names them: the spotlight saying which of your holes a player feeds. The squares that used to carry this are gone - the board prints the figures now - but "strong here" still needs a line somewhere, and this is the same 70th percentile it always was.
const STRONG_PERCENTILE = 70;

// The Draft tab. Three faces, built in order and shipped as they land: the cheat sheet reads the pool before a pick is made, the mock draft exercises the room offline, and the room itself runs on live picks. This file owns the tab's chrome - the header line, the face bar, and which face is on screen. Each face's body is built by its own renderer below. The tab exists for every league. Whether it can say anything useful depends on the pool: ESPN files season projections beside the actuals in the payload the leaderboard already fetches, so the sheet costs no request, but a pool that carries none has nothing to rank and says so.

const CHEAT_SHEET = 'sheet';
const MOCK_DRAFT = 'mock';

// The two faces that are not built yet. They are shown rather than hidden because the tab's shape is part of what it communicates - a face bar with one face on it reads like a bug, and a reader who can see what is coming does not go looking for it in the other tabs.
const FACES = [
    { id: CHEAT_SHEET, label: 'Cheat sheet', ready: true },
    { id: 'mock', label: 'Mock draft', ready: true },
    { id: 'room', label: 'Draft room', ready: false }
];

let activeFace = CHEAT_SHEET;
let poolSearch = '';
let posFilter = 'All';

// THE QUEUE: the players this reader is watching, for this sitting only. Module state and nothing else - no storage, no settings, no migration. A draft queue is a thing you build in the twenty minutes before a draft and throw away after it, and the moment it is persisted it becomes something that can be stale, wrong for this league, or in the way. It survives a re-render and a face switch, which is all it has to do.
const queue = new Set();

// Per-league state, cleared the same way the History tab clears its own (registerLeagueView's reset) - a face left open on one league must not decide what the next league opens on, and a position pill from a baseball league means nothing in a hockey one.
export function resetDraftView() {
    activeFace = CHEAT_SHEET;
    poolSearch = '';
    posFilter = 'All';
    mock = null;
    mockSetup = null;
    spotlightId = null;
    // A queue is a list of players in THIS league's pool. It means nothing in the next one.
    queue.clear();
}

export function queuedIds() {
    return queue;
}

// ==== The header line ====

// How the league scores, in the words the rest of the app uses. Read from the loaded payload rather than from AppState.isPointsLeague alone, because roto and head-to-head categories are both "not points" and the draft reads differently in each.
function formatWord() {
    const type = AppState.apiData?.settings?.scoringSettings?.scoringType || '';
    if (type === 'ROTO') return 'Roto';
    if (type === 'H2H_POINTS') return 'Points';
    return 'H2H cats';
}

// The draft's own date, local, MM-DD - the same shape the trend chart's day axis uses, for the same reason: it is the day something happens where the reader is, and the app formats no other kind of date. A league that has not scheduled its draft says so instead of showing an epoch.
function draftDateLabel() {
    const at = Number(AppState.apiData?.settings?.draftSettings?.date) || 0;
    if (!at) return 'draft date not set';
    const d = new Date(at);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `drafts ${mm}-${dd}`;
}

function headerLine() {
    const s = AppState.apiData?.settings || {};
    const teams = Number(s.size) || (AppState.apiData?.teams || []).length;
    return [s.name || 'This league', `${teams} teams`, formatWord(), draftDateLabel()];
}

export function poolHasProjections() {
    return (AppState.playerData || []).some(hasProjection);
}

function categoryNames(ids) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    return ids.map(id => map[id] || `Stat ${id}`);
}

// ==== The board ====

// Whether ANY player has a real draft position. When none does the column is all filler and the board drops it rather than printing a blank stripe down the page.
function poolHasAdp() {
    const filler = adpFiller();
    return (AppState.playerData || []).some(p => Number(p.adp) > 0 && Number(p.adp) !== filler);
}

// HOW MANY PLAYERS THIS LEAGUE WILL ACTUALLY TAKE. Every roster seat the league allows, bench and injury slots included, times the number of teams. It is the last pick of the draft.
export function draftableCount() {
    const settings = AppState.apiData?.settings || {};
    const counts = settings.rosterSettings?.lineupSlotCounts || {};
    const perTeam = Object.keys(counts).reduce((sum, id) => sum + Math.max(0, Number(counts[id]) || 0), 0);
    const teams = Number(settings.size) || (AppState.apiData?.teams || []).length || 0;
    return perTeam * teams;
}

// TIERS ARE DRAWN OVER THE DRAFTABLE RANGE ONLY. tierBreaks cuts any run longer than its maxSize, so run over a whole three-thousand-player pool it returns a divider every twelve rows for the length of the board - measured at over a hundred of them, which is not a tiering of anything, it is a ruler. A tier is a drafting aid and there is no draft after the last pick, so the breaks are taken over the players the league will actually take and the tail below runs unbroken. TIERS, WORKED OUT ONCE AND CARRIED BY THE ROW. A divider only makes sense over an unbroken run of the board, so a search or a position pill used to erase every trace of tiering - which is exactly when a reader most needs it, because a filtered list of shortstops says nothing about where the drop-offs are. Each ranked row now knows its own tier, so the label survives any filter even when the rule cannot be drawn.
function tierIndex(rows) {
    const ranked = rows.filter(r => r.value !== null);
    const limit = Math.min(ranked.length, draftableCount() || ranked.length);
    const noteByIndex = new Map();
    const noteById = new Map();
    if (limit < 2) return { noteByIndex, noteById };
    const breaks = tierBreaks(ranked.slice(0, limit));
    breaks.forEach((startIndex, i) => {
        const end = i + 1 < breaks.length ? breaks[i + 1] : limit;
        const note = tierNoteFor(i + 1);
        // The first tier needs no divider - the header row above it already says the board starts - but it still needs its name, because a filtered row from it has nothing else to say.
        if (i > 0) noteByIndex.set(startIndex, note);
        for (let j = startIndex; j < end; j++) noteById.set(ranked[j].player.id, note);
    });
    return { noteByIndex, noteById };
}

// A TIER SAYS WHICH TIER IT IS AND NOTHING ELSE. It carried the scarcest position in it and that position's word, which put the same three or four warnings down the length of the board - "OF cliff" on four dividers in a row - restating on every break what one card already says once. Scarcity is a property of a POSITION, not of a band of the board, and it belongs where it is answered: the depth card.
function tierNoteFor(number) {
    return `Tier ${number}`;
}

// Pre-draft, a player already on a roster is a keeper and cannot be taken. AFTER the draft every pooled player is on a roster or a waiver wire and the distinction says nothing, so the mark is only drawn while it means something.
function keptRow(row) {
    return !AppState.apiData?.draftDetail?.drafted && !!row.player.teamId;
}

function visibleRows(rows) {
    const sport = AppState.loadedSport;
    const needle = poolSearch.trim().toLowerCase();
    return rows.filter(r => {
        if (posFilter !== 'All' && !r.player.eligiblePositions.includes(posFilter)) return false;
        if (needle && !r.player.name.toLowerCase().includes(needle)) return false;
        return true;
    });
}

// Every position the pool is eligible at, both groups, in the leaderboard's own order - batters then pitchers, or skaters then goalies, because that is the order those tabs already put them in.
function positionPills() {
    const sport = AppState.loadedSport;
    const pool = (AppState.playerData || []).filter(hasProjection);
    return ['All'].concat(
        positionOptionsFor(pool.filter(p => matchesPlayerGroup(p, sport, false)), sport, false),
        positionOptionsFor(pool.filter(p => matchesPlayerGroup(p, sport, true)), sport, true)
    );
}

// ==== Rendering ====

// ==== The rail ====

// Where the user picks, from the league's own first-round order. pickOrder is a list of team ids, so the slot is where this user's team sits in it. A league the user only spectates has no slot, which is a real state and says so rather than showing a 1.
function ownSlot() {
    const order = AppState.apiData?.settings?.draftSettings?.pickOrder || [];
    const teamId = findOwnedTeamId(AppState.apiData?.teams, AppState.userSwid);
    if (!teamId) return null;
    const at = order.indexOf(teamId);
    return at >= 0 ? at + 1 : null;
}

function draftTypeWord() {
    const type = String(AppState.apiData?.settings?.draftSettings?.type || '').toLowerCase();
    return type ? type.replace(/_/g, ' ') : 'draft type not set';
}

// EVERY STARTING SEAT, one entry each, in the league's own order - so a league that starts three outfielders reads as three seats rather than as the number three. The bench is a count, because a bench seat has no position to name.
function startingSeats() {
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const order = LINEUP_SLOT_ORDER[sport] || [];
    const slots = order.concat(Object.keys(counts).map(Number).filter(s => !order.includes(s)));
    const seats = [];
    let benched = 0;
    slots.forEach(slot => {
        const n = Number(counts[slot]) || 0;
        if (n <= 0) return;
        if (bench.has(slot)) { benched += n; return; }
        const label = labels[slot];
        for (let i = 0; i < n; i++) seats.push(label || String(slot));
    });
    return { seats, benched };
}

// The league's roster shape in its own slot names, starters then the bench.
function rosterShape() {
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const order = LINEUP_SLOT_ORDER[sport] || [];
    // The league's own order first, then anything it rosters that the order does not list, so an unfamiliar construction is appended rather than dropped.
    const slots = order.concat(Object.keys(counts).map(Number).filter(s => !order.includes(s)));
    const starters = [];
    let benched = 0;
    slots.forEach(slot => {
        const n = Number(counts[slot]) || 0;
        if (n <= 0) return;
        if (bench.has(slot)) { benched += n; return; }
        // "1 1B", never "11B". The mockup ran the count into the label, which works for hockey's single-letter positions and collides badly with baseball's - a league starting one first baseman read "11B" and a league starting eleven would read the same.
        starters.push(`${n} ${labels[slot] || ''}`.trim());
    });
    const parts = starters.slice();
    if (benched) parts.push(`${benched} BN`);
    return parts;
}

function setupCardHtml(rows) {
    const teams = Number(AppState.apiData?.settings?.size) || (AppState.apiData?.teams || []).length;
    const slot = ownSlot();
    // SHOWN, NOT RECITED. This card was four sentences of middot-separated prose describing a shape - "1 C · 1 1B · 1 2B · 1 3B · 1 SS · 3 OF" - which a reader has to parse back into a roster in mind. The seats are drawn as seats now, one chip each, in the league's own order, so the shape is read rather than counted. The chip is.mt-diff-chip at its neutral setting: at --diff 50 both of its mixes fall to zero and it resolves to a plain bordered chip in --text-subtle, which is exactly the component wanted and one the app already carries.
    const { seats, benched } = startingSeats();
    const chips = seats.map(label => `<span class="mt-diff-chip" style="--diff:50">${escapeHtml(label)}</span>`).join('')
        + (benched ? `<span class="mt-diff-chip dr-bench-chip" style="--diff:50">+${benched} BN</span>` : '');

    const head = [`${teams} teams`, draftTypeWord()];
    if (slot) head.push(`slot ${slot}`);
    const codes = categoryNames(Array.from(AppState.scoredStatIds)).join(' ');

    const lines = [`<div class="dr-setup-head">${escapeHtml(head.join(` ${MIDDOT} `))}</div>`];
    if (!slot) lines.push('<div class="dr-quiet">No team of yours in this league.</div>');
    lines.push(`<div class="dr-slotgrid">${chips}</div>`);
    lines.push(`<div class="dr-setup-head">${AppState.scoredStatIds.size} categories</div>`);
    lines.push(`<div class="dr-catcodes">${escapeHtml(codes)}</div>`);
    // Keepers appear only when there ARE keepers. "None reported" is not news.
    const keepers = keepersLine(rows);
    if (!keepers.quiet) lines.push(`<div class="dr-quiet">Keepers: ${escapeHtml(keepers.text)}</div>`);
    return cardHtml('League Setup', lines.join(''));
}

// The AppState half of the pre-draft depth read. The maths moved to draft-engine.js so the preseason face can use it without importing a view; what is left here is the part that was never pure - which league is loaded, and what its slots say.
function scarcityRows(rows) {
    const sport = AppState.loadedSport;
    return positionDepth(rows, {
        counts: AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {},
        labels: LINEUP_SLOT_LABELS[sport] || {},
        bench: NON_STARTING_SLOTS[sport] || new Set(),
        flex: FLEX_SLOTS[sport] || new Set(),
        teams: Number(AppState.apiData?.settings?.size) || (AppState.apiData?.teams || []).length || 0
    });
}

function scarcityCardHtml(rows) {
    const list = scarcityRows(rows);
    if (!list.length) return '';
    const body = list.map(s => {
        // Two starting jobs' worth of players is a deep position; the bar fills to there and stops, so "deep" reads as full rather than as an ever-growing number nobody acts on.
        const fill = Math.max(4, Math.min(100, Math.round((s.ratio / 2) * 100)));
        const cls = s.word ? ` dr-sc-${s.word}` : '';
        return `<div class="dr-sc-pos">${escapeHtml(s.pos)}</div>`
            + `<div class="dr-sc-track" title="${escapeHtml(`${s.available} players above replacement for ${s.starters} starting jobs`)}">`
            + `<div class="dr-sc-fill${cls}" style="width:${fill}%"></div></div>`
            + `<div class="dr-sc-word${cls}">${escapeHtml(s.word)}</div>`;
    }).join('');
    // "Position depth", not "scarcity at your slot" - the arithmetic is league-wide and says nothing about where you pick, so the title must not claim it does.
    return cardHtml('Position depth', `<div class="dr-sc-grid">${body}</div>`);
}

// Keepers are only a fact before the draft - see keptRow. When there is nothing to report it is one muted line inside Setup rather than a card of its own; when there IS, it earns the card.
function keepersLine(rows) {
    const marked = (rows || []).filter(keptRow).length;
    const declared = Number(AppState.apiData?.settings?.draftSettings?.keeperCount) || 0;
    if (marked) return { quiet: false, text: `${marked} marked out of the pool.` };
    if (declared) return { quiet: false, text: `${declared} per team, none marked in the pool yet.` };
    return { quiet: true, text: 'none reported' };
}

function keepersCardHtml(rows) {
    const line = keepersLine(rows);
    return line.quiet ? '' : cardHtml('Keepers', `<div>${escapeHtml(line.text)}</div>`);
}

// The rail's cards wear the app's own block head - the class applied ALONGSIDE rather than the rules copied, and the dr- name kept, because a History prefix on a draft card would be a lie about where the markup lives even if the styling is shared.
function cardHtml(label, body) {
    return `<div class="dr-card"><div class="dr-card-label lh-block-head">${escapeHtml(label)}</div>`
        + `<div class="dr-card-body">${body}</div></div>`;
}

function railHtml(rows) {
    return `<div class="draft-rail">${setupCardHtml(rows)}${scarcityCardHtml(rows)}${keepersCardHtml(rows)}`
        + '<button type="button" id="draft-export-btn" class="dm-flat dr-export">Export sheet</button></div>';
}


// ==== The mock draft ====

// How far down the consensus a bot will reach. The words are the setup strip's; the numbers are botPick's variance, which scales its window.
const VARIANCE = { Low: 0.25, Medium: 0.5, High: 1 };

// The run of live state. Null until a draft is started, which is also what the setup strip tests.
let mock = null;

// Every team's id, in the league's own order.
function leagueTeamIds() {
    return (AppState.apiData?.teams || []).map(t => t.id);
}

function teamNameOf(teamId) {
    const team = (AppState.apiData?.teams || []).find(t => t.id === teamId);
    if (!team) return `Team ${teamId}`;
    return team.name || `${team.location || ''} ${team.nickname || ''}`.trim() || `Team ${teamId}`;
}

// STARTING SLOTS BY POSITION, per team. The same reading the scarcity card runs on, factored out so the card, the bots' needs and the roster panel cannot drift apart. Flex seats are excluded: no player is eligible "at UTIL", and a seat that takes whoever is left is not a position anyone is short of.
const FLEX_LABELS = new Set(['UTIL', 'IF', 'MI', 'CI', 'P']);

function startingSlotsByPosition() {
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const out = {};
    Object.keys(counts).forEach(key => {
        const slot = Number(key);
        const n = Number(counts[key]) || 0;
        const label = labels[slot];
        if (n <= 0 || bench.has(slot) || !label || FLEX_LABELS.has(label)) return;
        out[label] = (out[label] || 0) + n;
    });
    return out;
}

// The first round's team order with the user sitting at the slot the setup strip chose. The league's own pickOrder is the starting point, so a league that has set one keeps its shape.
function firstRoundOrder(slot) {
    const declared = AppState.apiData?.settings?.draftSettings?.pickOrder;
    const base = (declared && declared.length ? declared.slice() : leagueTeamIds());
    if (!base.length) return [];
    const me = findOwnedTeamId(AppState.apiData?.teams, AppState.userSwid) || base[0];
    const rest = base.filter(id => id !== me);
    const at = Math.min(Math.max(1, Number(slot) || 1), base.length) - 1;
    rest.splice(at, 0, me);
    return rest;
}

function mockDefaults() {
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    const capacity = teams ? Math.max(1, Math.round(draftableCount() / teams)) : 1;
    return {
        slot: ownSlot() || 1,
        rounds: capacity,
        variance: 'Medium',
        // Shown so a draft can be re-run. Any integer does; this one just has to differ per run.
        seed: 1000 + Math.floor(Math.random() * 9000)
    };
}

let mockSetup = null;

function startMock() {
    const setup = mockSetup || mockDefaults();
    const rows = buildBoard().filter(r => r.value !== null);
    const order = draftOrder(firstRoundOrder(setup.slot), setup.rounds,
        AppState.apiData?.settings?.draftSettings?.type || 'SNAKE');
    const byId = new Map(rows.map(r => [r.player.id, r]));
    mock = {
        ...setup,
        order,
        rows,
        byId,
        // Consensus is the CROWD's order - ADP where ESPN has one, value behind it. The bots draft this; the board beside them is yours. The two disagreeing is the whole point of a sheet.
        consensus: rows.slice().sort((a, b) => {
            const aa = adpOf(a.player), ba = adpOf(b.player);
            if (aa && ba) return aa - ba;
            if (aa) return -1;
            if (ba) return 1;
            return b.value - a.value;
        }).map(r => ({ id: r.player.id, positions: r.player.eligiblePositions || [] })),
        slots: startingSlotsByPosition(),
        userTeamId: firstRoundOrder(setup.slot)[Math.min(Math.max(1, setup.slot), 99) - 1],
        state: initialDraftState(order, setup.seed),
        stack: []
    };
}

function takenSet(state) {
    const taken = new Set();
    Object.keys(state.rosters).forEach(t => state.rosters[t].forEach(id => taken.add(id)));
    return taken;
}

function needsFor(state, teamId) {
    const positions = (state.rosters[teamId] || [])
        .map(id => (mock.byId.get(id)?.player.eligiblePositions) || []);
    return openNeeds(positions, mock.slots);
}

// THE BOT'S RANDOMNESS IS A FUNCTION OF THE STATE, not a generator ticking along beside it. A shared generator would advance as picks are made, so undoing a pick and making the same choice again would produce a DIFFERENT draft from there - which breaks the one promise the seed makes. Seeded per pick from the draft's seed, any state replays to the same picks however it was reached.
function randFor(state) {
    return seededRandom((mock.seed + state.pickIndex * 7919) >>> 0);
}

function botChoice(state) {
    const taken = takenSet(state);
    const needs = needsFor(state, teamOnClock(state));
    const candidates = mock.consensus.filter(c => !taken.has(c.id));
    const pick = botPick(candidates, needs, VARIANCE[mock.variance] ?? 0.5, randFor(state));
    return pick ? pick.id : null;
}

function advanceBots() {
    mock.stack.push(mock.state);
    mock.state = simToTeam(mock.state, mock.userTeamId, botChoice);
}

function draftForUser(playerId) {
    mock.stack.push(mock.state);
    mock.state = applyPick(mock.state, playerId);
    mock.state = simToTeam(mock.state, mock.userTeamId, botChoice);
}

function undoMock() {
    if (mock.stack.length) mock.state = mock.stack.pop();
}

// ==== What the mock knows ====

// YOUR NEXT TURN AFTER THIS PICK, which is the one every question on this face is really about: whether a player lasts, how many teams are in the way, what the gap to that ADP is. Counting from the pick AFTER the current one matters when the current one is yours - "lasts to 3?" while you are picking at 3 is not a question, and the answer to the real one is a round away.
function myNextPickIndex(state) {
    for (let i = state.pickIndex + 1; i < state.order.length; i++) {
        if (state.order[i] === mock.userTeamId) return i;
    }
    return -1;
}

function positionsOf(playerId) {
    return (mock.byId.get(playerId)?.player.eligiblePositions) || [];
}

function primaryPositionOf(playerId) {
    return positionsOf(playerId)[0] || '';
}

function coverageNow(state) {
    const sport = AppState.loadedSport;
    const cats = Array.from(AppState.scoredStatIds);
    const specs = RATE_COMPONENTS[sport] || [];
    const sums = {};
    leagueTeamIds().forEach(t => {
        const lines = (state.rosters[t] || []).map(id => mock.byId.get(id)?.totals || {});
        sums[t] = rosterTotals(lines, cats, specs);
    });
    return coverageOf(sums, mock.userTeamId, cats, { inverseIds: INVERSE_STATS[sport] || new Set() });
}

function availableRows(state) {
    const taken = takenSet(state);
    return mock.rows.filter(r => !taken.has(r.player.id));
}

// ==== The face ====

function mockStateLine(state) {
    if (draftComplete(state)) return ['Draft complete'];
    const teams = mock.order.length && mockSetup ? firstRoundOrder(mockSetup.slot).length : leagueTeamIds().length;
    const round = teams ? Math.floor(state.pickIndex / teams) + 1 : 1;
    const onClock = teamOnClock(state);
    return [
        `Round ${round}`,
        `pick ${state.pickIndex + 1}`,
        onClock === mock.userTeamId ? 'you are on the clock' : `${teamNameOf(onClock)} on the clock`
    ];
}

// Whether the last part of that line is about YOU, which is the one clause on the masthead that should carry weight - a reader glancing up wants to know if it is their turn, not whose it is.
function mockStateIsYours(state) {
    return !!mock && !draftComplete(state) && teamOnClock(state) === mock.userTeamId;
}

// THE STREAM: what went, what is going, and what stands between you and your next turn. A pick that has happened names the PLAYER and the position - the team that took them is the small print, because a reader scanning the run wants to know what came off the board. The run warning used to be a red sentence under the strip; it now rides the clock chip's own second line, because a run is a fact about THIS pick and a separate sentence was a second place to look. The horizon chip is what makes the strip finite. Listing every team between you and your next pick is a wall of chips nobody counts; one chip saying which picks they are and that you are after them is the same information in a glance.
function streamHtml(state) {
    const chips = [];
    state.picks.slice(-3).forEach(p => {
        const row = mock.byId.get(p.playerId);
        const pos = primaryPositionOf(p.playerId);
        chips.push(`<div class="dm-chip dm-chip-done">`
            + `<span class="dm-chip-top">${p.pick} ${MIDDOT} ${escapeHtml(teamNameOf(p.teamId))}</span>`
            + `<span class="dm-chip-name">${escapeHtml(row ? row.player.name : '')}`
            + (pos ? ` <span class="dm-chip-pos">${escapeHtml(pos)}</span>` : '') + '</span></div>');
    });

    if (!draftComplete(state)) {
        const onClock = teamOnClock(state);
        const yours = onClock === mock.userTeamId;
        const run = runDetect(state.picks.map(p => primaryPositionOf(p.playerId)));
        const second = 'on the clock' + (run ? ` ${MIDDOT} ${run.count} ${run.position} run` : '');
        chips.push(`<div class="dm-chip dm-chip-now">`
            + `<span class="dm-chip-top">${state.pickIndex + 1} ${MIDDOT} ${escapeHtml(yours ? 'YOU' : teamNameOf(onClock))}</span>`
            + `<span class="dm-chip-name">${escapeHtml(second)}</span></div>`);

        const mine = myNextPickIndex(state);
        const horizon = mine >= 0 ? mine : state.order.length;
        const shown = Math.min(state.pickIndex + 3, horizon);
        for (let i = state.pickIndex + 1; i < shown; i++) {
            const team = state.order[i];
            const needs = needsFor(state, team);
            // EVERY open need, not the alphabetically-first one. A team short at two positions is a different threat from a team short at one, and naming only one hid that.
            const open = Object.keys(needs).filter(pos => needs[pos] > 0).sort();
            chips.push(`<div class="dm-chip dm-chip-next">`
                + `<span class="dm-chip-top">${i + 1} ${MIDDOT} ${escapeHtml(teamNameOf(team))}</span>`
                + `<span class="dm-chip-name">${open.length ? 'needs ' + escapeHtml(open.join(', ')) : 'roster full'}</span></div>`);
        }
        if (mine > shown) {
            chips.push(`<div class="dm-chip dm-chip-next dm-chip-horizon">`
                + `<span class="dm-chip-top">${shown + 1}-${mine}</span>`
                + '<span class="dm-chip-name">then you</span></div>');
        }
    }

    return `<div class="dm-stream">${chips.join('')}</div>`;
}

// THE SPOTLIGHT'S REASONS. Every sentence is built from a fact a pure function produced, and every one of them is a thing a reader can disagree with - never a number claiming to be a probability.
function spotlightReasons(state, row) {
    const out = [];
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const pid = row.player.id;
    const openSeats = new Set(assignRoster(state.rosters[mock.userTeamId]).open);
    const openAt = positionsOf(pid).filter(p => openSeats.has(p));
    const coverage = coverageNow(state);
    const holes = new Set(holesFrom(coverage));
    const feeds = (row.cells || [])
        .filter(c => c.pct !== null && c.pct >= STRONG_PERCENTILE && holes.has(c.id))
        .map(c => map[c.id] || c.id);

    if (openAt.length) {
        const feed = feeds.length ? ` and feeds ${feeds.slice(0, 2).join(' and ')}, ${feeds.length > 1 ? 'two of your holes' : 'one of your holes'}` : '';
        out.push(`Fills your open ${openAt[0]} slot${feed}.`);
    } else if (feeds.length) {
        out.push(`Feeds ${feeds.slice(0, 2).join(' and ')}, where you are behind the league.`);
    }

    // The tier the player sits in, and how many of that position are left in it.
    const avail = availableRows(state);
    const index = avail.findIndex(r => r.player.id === pid);
    if (index >= 0) {
        const limit = Math.min(avail.length, draftableCount() || avail.length);
        const breaks = tierBreaks(avail.slice(0, limit));
        const tier = tierOf(index, breaks);
        const start = breaks[tier - 1] ?? 0;
        const end = breaks[tier] ?? limit;
        const pos = primaryPositionOf(pid);
        const left = avail.slice(start, end).filter(r => (r.player.eligiblePositions || []).includes(pos)).length;
        if (left > 0 && end < limit) out.push(`Tier ${tier + 1} has ${left} ${pos} left.`);
    }

    // The gap, and only when it is a reason to act. "ADP 38, you pick 54" says the pick will be gone; "ADP 60, you pick 54" says you can wait, which is not an argument for spending the pick and reads as one in a list of them. Never odds - the distance is the whole statement.
    const nextIndex = myNextPickIndex(state);
    const adp = adpOf(row.player);
    if (adp && nextIndex > state.pickIndex && adp <= nextIndex + 1) {
        out.push(`ADP ${adp.toFixed(0)}, you pick ${nextIndex + 1}.`);
    }

    if (out.length < 3 && nextIndex > state.pickIndex) {
        const needsByTeam = {};
        leagueTeamIds().forEach(t => { needsByTeam[t] = needsFor(state, t); });
        const pos = primaryPositionOf(pid);
        const threats = threatCount(state.order, state.pickIndex + 1, nextIndex, needsByTeam, pos);
        const between = new Set(state.order.slice(state.pickIndex + 1, nextIndex)).size;
        // One team in between is not "1 of the 1 teams". The verb agrees with the count rather than with the teams - "1 of the 3 teams needs SP", "2 of the 3 teams need SP". NO ARTICLE BEFORE A POSITION CODE. A code is a label, not a noun, and every other line on this tab already reads that way - the stream says "needs D", the tier rule says "SP short". The alternative is an article rule per code across three sports, to decide that SS takes "an" and SP takes "an" but C takes "a", which is a maintenance burden for no reader.
        if (threats > 0) {
            out.push(between === 1
                ? `The team before your next pick needs ${pos}.`
                : `${threats} of the ${between} teams before your next pick ${threats === 1 ? 'needs' : 'need'} ${pos}.`);
        }
    }

    return out.slice(0, 3);
}

// WHO THE BANNER IS ABOUT. The board's best fit by default, or whichever alternative the reader clicked - held until the pick is made, so choosing an alternative and drafting it takes two clicks and never one. A pick nobody meant to make is the one thing a room must not allow.
let spotlightId = null;

function spotlightRowFor(state) {
    const avail = availableRows(state);
    if (!avail.length) return null;
    if (spotlightId !== null) {
        const held = avail.find(r => r.player.id === spotlightId);
        if (held) return held;
        spotlightId = null;
    }
    const open = new Set(assignRoster(state.rosters[mock.userTeamId]).open);
    return avail.find(r => (r.player.eligiblePositions || []).some(p => open.has(p))) || avail[0];
}

// The two the reader should also be looking at: anything QUEUED that is still on the board comes first, because the reader already asked for it, then the next best that fills an open seat.
function alternativesFor(state, chosen) {
    const avail = availableRows(state).filter(r => r.player.id !== chosen.player.id);
    const open = new Set(assignRoster(state.rosters[mock.userTeamId]).open);
    const picked = [];
    const take = (r) => { if (r && !picked.some(x => x.player.id === r.player.id)) picked.push(r); };
    avail.filter(r => queue.has(r.player.id)).slice(0, 2).forEach(take);
    avail.filter(r => (r.player.eligiblePositions || []).some(p => open.has(p))).forEach(r => {
        if (picked.length < 2) take(r);
    });
    avail.forEach(r => { if (picked.length < 2) take(r); });
    return picked.slice(0, 2);
}

function spotlightHtml(state) {
    if (draftComplete(state)) {
        return '<div class="dm-banner dm-banner-done">The draft is over. Your roster is on the right.</div>';
    }
    const row = spotlightRowFor(state);
    if (!row) return '';
    const yours = teamOnClock(state) === mock.userTeamId;
    const adp = adpOf(row.player);
    const mine = myNextPickIndex(state);

    // The facts a reader checks before spending a pick, in one muted run.
    const facts = [];
    if (adp) facts.push(`ADP ${adp.toFixed(0)}`);
    const tierNote = tierIndex(availableRows(state)).noteById.get(row.player.id);
    if (tierNote) facts.push(tierNote);
    const reasons = spotlightReasons(state, row).join(` ${MIDDOT} `);

    const alts = alternativesFor(state, row).map(a => {
        const aAdp = adpOf(a.player);
        const word = survivalWord(aAdp, mine >= 0 ? mine + 1 : 0, state.pickIndex + 1);
        const tone = word === 'likely' ? ' dm-likely' : (word === 'coin flip' ? ' dm-coin' : (word ? ' dm-gone' : ''));
        return `<button type="button" class="dm-alt" data-spot="${a.player.id}">`
            + `<span class="dm-alt-name">${escapeHtml(a.player.name)}</span>`
            + `<span class="dm-alt-pos">${escapeHtml(a.player.positionDisplay || '')}</span>`
            + `<span class="dm-alt-value">${a.value.toFixed(0)}</span>`
            + (word ? `<span class="dm-alt-word${tone}">${escapeHtml(word)}</span>` : '') + '</button>';
    }).join('');

    return `
        <div class="dm-banner">
            <div class="dm-banner-line">
                <span class="dm-banner-at">Your pick at #${yours ? state.pickIndex + 1 : (mine >= 0 ? mine + 1 : state.pickIndex + 1)}</span>
                <span class="dm-spot-name">${escapeHtml(row.player.name)}</span>
                <span class="dm-spot-pos">${escapeHtml(row.player.positionDisplay || '')}</span>
                <span class="dm-spot-value">${row.value.toFixed(0)}</span>
                <span class="dm-spot-meta">${escapeHtml(facts.join(` ${MIDDOT} `))}</span>
            </div>
            ${reasons ? `<div class="dm-banner-why">${escapeHtml(reasons)}</div>` : ''}
            <div class="dm-banner-act">
                <button type="button" id="dm-draft" class="dm-primary"${yours ? '' : ' disabled'} data-id="${row.player.id}">Draft ${escapeHtml(row.player.name)}</button>
                ${alts ? `<span class="dm-alt-label">Also strong</span>${alts}` : ''}
                <button type="button" id="dm-sim" class="dm-flat">Sim ahead</button>
                <button type="button" id="dm-undo" class="dm-flat"${mock.stack.length ? '' : ' disabled'}>Undo</button>
            </div>
        </div>
    `;
}

function bestAvailableHtml(state) {
    const avail = visibleRows(availableRows(state)).slice(0, 120);
    const nextIndex = myNextPickIndex(state);
    const nextPick = nextIndex >= 0 ? nextIndex + 1 : 0;
    const catIds = Array.from(AppState.scoredStatIds);
    const clubs = proTeamAbbrevs();
    const draftable = draftableCount();
    // The room's board is the sheet's board. Same tiers, same queue, same star - a reader who learned the shape on one face does not relearn it on the other, and the tier a player sits in matters MORE with a clock running than it does the night before.
    const columns = 6 + catIds.length;
    const tiers = tierIndex(avail);
    const queued = avail.filter(r => queue.has(r.player.id));
    const queuedIdSet = new Set(queued.map(r => r.player.id));

    // ANY ROW IS DRAFTABLE. The spotlight is a recommendation, not a gate - a manager who wants the pick at number forty takes them. Quiet until the row is hovered, so three thousand buttons do not shout, and always visible in the queue where the reader has already said what they want.
    const yours = teamOnClock(state) === mock.userTeamId;
    const mockRow = (r, note) => {
        const adp = adpOf(r.player);
        const word = survivalWord(adp, nextPick, state.pickIndex + 1);
        const tone = word === 'likely' ? ' dm-likely' : (word === 'coin flip' ? ' dm-coin' : (word ? ' dm-gone' : ''));
        const says = word === 'likely' ? `likely, ADP ${adp.toFixed(0)}`
            : (word === 'no' ? `no, ADP ${adp ? adp.toFixed(0) : '-'}` : word);
        const action = yours
            ? `<button type="button" class="dm-rowdraft" data-draft="${r.player.id}" title="${escapeHtml('Draft ' + r.player.name)}">Draft</button>`
            : '';
        return `<tr>
            ${starCellHtml(r.player.id)}
            <td class="dr-num dr-rank"${note ? ` title="${escapeHtml(note)}"` : ''}>${r.boardRank || ''}</td>
            ${identityCellHtml(r.player, false, clubs, action, !!r.boardRank && (!draftable || r.boardRank <= draftable))}
            <td class="dr-num dr-pos" title="${escapeHtml(r.player.positionDisplay || '')}">${escapeHtml(r.player.positionDisplay || '')}</td>
            <td class="dr-num dr-value">${r.value.toFixed(1)}</td>
            <td class="dr-num dm-survive${tone}">${escapeHtml(says)}</td>
            ${categoryCellsHtml(r, catIds)}
        </tr>`;
    };

    let body = '';
    if (queued.length) {
        body += `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">`
            + `Queue ${MIDDOT} ${queued.length}</td></tr>`;
        body += queued.map(r => mockRow(r, tiers.noteById.get(r.player.id))).join('');
        body += `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">Board</td></tr>`;
    }
    body += avail.map((r, i) => {
        const head = tiers.noteByIndex.has(i) ? tierRowHtml(tiers.noteByIndex.get(i), columns) : '';
        if (queuedIdSet.has(r.player.id)) return head;
        return head + mockRow(r, tiers.noteById.get(r.player.id));
    }).join('');

    return `
        <div class="dr-scroll dm-scroll">
            <table class="dr-table">
                <thead><tr>
                    <th class="dr-col-star" title="Queue"></th>
                    <th class="dr-col-rank">#</th>
                    <th class="dr-col-name">Player</th>
                    <th class="dr-col-pos">Pos</th>
                    <th class="dr-col-value">Value</th>
                    <th class="dm-col-survive">Lasts to ${nextPick || '-'}?</th>
                    ${categoryHeadsHtml(catIds)}
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>
    `;
}

// PUTTING A ROSTER INTO ITS SEATS. One assignment, read by the panel that draws it AND by the spotlight that argues about it - so "open" means the same thing in both, which is the whole point of doing it once. Two rules, both learned from a finished roster that looked wrong: SPECIFIC SEATS BEFORE FLEX ONES. The league's display order puts UTIL and P before SP and RP, and filling in that order let a flex seat take a pitcher that the SP seat then had no replacement for. Every named seat is filled first and the flex seats take whoever is left, which is what a flex seat is for. THE LEAST VERSATILE PLAYER TAKES THE SEAT. Grabbing the first eligible body spends a multi-position player on the first seat it happens to match and leaves a later one open that only that player could have filled. Still a heuristic rather than an assignment solver, and it does not need to be one: it is right on every roster a fantasy league actually builds, and its failure mode is a seat drawn open beside a bench player who could have taken it - visible, not silent.
function assignRoster(playerIds) {
    const sport = AppState.loadedSport;
    const counts = AppState.apiData?.settings?.rosterSettings?.lineupSlotCounts || {};
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const bench = NON_STARTING_SLOTS[sport] || new Set();
    const order = LINEUP_SLOT_ORDER[sport] || [];
    const mine = (playerIds || []).slice();

    const seats = [];
    order.concat(Object.keys(counts).map(Number).filter(s => !order.includes(s))).forEach(slot => {
        const n = Number(counts[slot]) || 0;
        const label = labels[slot];
        if (n <= 0 || bench.has(slot) || !label) return;
        for (let i = 0; i < n; i++) seats.push({ label, flex: FLEX_LABELS.has(label), id: null });
    });

    const take = (label) => {
        let best = -1;
        let fewest = Infinity;
        mine.forEach((id, i) => {
            const pos = positionsOf(id);
            if (!pos.includes(label) || pos.length >= fewest) return;
            fewest = pos.length;
            best = i;
        });
        return best >= 0 ? mine.splice(best, 1)[0] : null;
    };

    seats.filter(s => !s.flex).forEach(seat => { seat.id = take(seat.label); });
    seats.filter(s => s.flex).forEach(seat => { seat.id = mine.length ? mine.shift() : null; });

    return {
        seats,
        // Only a NAMED seat counts as a hole worth chasing. A flex seat takes anyone, so it is never a reason to prefer one player over another.
        open: seats.filter(s => !s.flex && !s.id).map(s => s.label),
        bench: mine
    };
}

// WHICH PICK EACH PLAYER COST. A roster row without its pick number is a list of names; with it, it is a record of the draft you actually had.
function pickNumbersFor(state) {
    const by = new Map();
    state.picks.forEach(p => { if (p.teamId === mock.userTeamId) by.set(p.playerId, p.pick); });
    return by;
}

function rosterCardHtml(state) {
    const { seats, bench } = assignRoster(state.rosters[mock.userTeamId]);
    const picks = pickNumbersFor(state);
    const scarcity = new Map(liveScarcity(state).map(s => [s.pos, s]));
    // STARTING SEATS, not seats plus whatever is on the bench. The bench grows as the draft runs, so a denominator that counts it moves under the reader - "3 of 16" and later "9 of 19" are not the same scale. The seats the league starts are a fixed number and the one worth filling.
    const filled = seats.filter(s => s.id).length;
    const total = seats.length;

    // Only the NEXT empty seat is annotated. Every open seat carrying a scarcity word is a column of warnings a reader stops reading; the one about to be filled is the one that matters.
    let annotated = false;
    const rows = seats.map(seat => {
        const row = seat.id ? mock.byId.get(seat.id) : null;
        if (row) {
            const at = picks.get(seat.id);
            return `<div class="dm-slot"><span class="dm-slot-code">${escapeHtml(seat.label)}</span>`
                + `<span class="dm-slot-name">${escapeHtml(row.player.name)}</span>`
                + (at ? `<span class="dm-slot-pick">#${at}</span>` : '') + '</div>';
        }
        const s = !annotated ? scarcity.get(seat.label) : null;
        const warn = s && (s.word === 'short' || s.word === 'cliff');
        if (!annotated) annotated = true;
        return `<div class="dm-slot"><span class="dm-slot-code">${escapeHtml(seat.label)}</span>`
            + `<span class="dm-open">open${warn ? ` ${MIDDOT} ${escapeHtml(s.word)} at your next pick` : ''}</span></div>`;
    }).join('');

    const benchRows = bench.map(id => {
        const row = mock.byId.get(id);
        const at = picks.get(id);
        return `<div class="dm-slot dm-benched"><span class="dm-slot-code">BN</span>`
            + `<span class="dm-slot-name">${escapeHtml(row ? row.player.name : '')}</span>`
            + (at ? `<span class="dm-slot-pick">#${at}</span>` : '') + '</div>';
    }).join('');

    return cardHtml(`Your roster ${MIDDOT} ${filled} of ${total}`,
        rows + (benchRows ? `<div class="dm-bench-rule"></div>${benchRows}` : ''));
}

// SCARCITY WITH A CLOCK RUNNING, which is a different question from the sheet's. Before a draft the question is how many players are worth starting at all. Once picks are landing it is what scarcityOf was written for: who is LEFT against the jobs still to fill. Both numbers shrink as the draft goes, and the ratio between them is what tells a manager whether to reach.
function liveScarcity(state) {
    const perTeam = startingSlotsByPosition();
    const avail = availableRows(state).filter(r => r.value !== null && r.value >= 0);
    const teams = leagueTeamIds();
    const jobsByPos = {};
    Object.keys(perTeam).forEach(pos => {
        let jobs = 0;
        teams.forEach(t => {
            jobs += assignRoster(state.rosters[t]).open.filter(label => label === pos).length;
        });
        if (jobs > 0) jobsByPos[pos] = jobs;
    });
    // Bodies, not eligibilities - see assignBodies. One player cannot fill three seats.
    const bodies = assignBodies(avail, jobsByPos);
    return Object.keys(jobsByPos).map(pos => {
        const jobs = jobsByPos[pos];
        const left = bodies[pos] || 0;
        const { ratio, word } = scarcityOf(left, jobs);
        return { pos, jobs, left, ratio, word };
    }).sort((a, b) => a.ratio - b.ratio);
}

function liveScarcityCardHtml(state) {
    const list = liveScarcity(state);
    if (!list.length) return '';
    const body = list.map(s => {
        const fill = Math.max(4, Math.min(100, Math.round((s.ratio / 2) * 100)));
        const cls = s.word ? ` dr-sc-${s.word}` : '';
        return `<div class="dr-sc-pos">${escapeHtml(s.pos)}</div>`
            + `<div class="dr-sc-track" title="${escapeHtml(`${s.left} left for ${s.jobs} open ${s.pos} seats`)}">`
            + `<div class="dr-sc-fill${cls}" style="width:${fill}%"></div></div>`
            + `<div class="dr-sc-word${cls}">${escapeHtml(s.word)}</div>`;
    }).join('');
    return cardHtml('Scarcity now', `<div class="dr-sc-grid">${body}</div>`);
}

// COVERAGE, WITH THE FIGURE BESIDE IT. A bar alone says "you are behind" without saying by how much or against how many; "3 of 5" is the count a reader can act on, and the tick at the midline is what makes a bar readable as ahead-or-behind rather than as a length. The teams beaten are recovered from the share and the number compared, which is what coverageOf works in - no second arithmetic, just its own two numbers written out.
function coverageCardHtml(state) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const rivals = Math.max(0, leagueTeamIds().length - 1);
    const body = coverageNow(state).map(c => {
        const name = map[c.id] || `Stat ${c.id}`;
        if (c.share === null) {
            return `<div class="dm-cov-cat">${escapeHtml(name)}</div>`
                + `<div class="dm-cov-track" title="${escapeHtml(name + ': nothing drafted yet')}"></div>`
                + '<div class="dm-cov-of"></div>';
        }
        const pct = Math.round(c.share * 100);
        const beaten = Math.round(c.share * rivals);
        const tone = c.share >= 0.7 ? ' dm-cov-good' : (c.share <= 0.35 ? ' dm-cov-bad' : '');
        const figure = c.value === null ? '-' : formatCoverageValue(c.value);
        return `<div class="dm-cov-cat">${escapeHtml(name)}</div>`
            + `<div class="dm-cov-track" title="${escapeHtml(`${name}: ${figure}, ahead of ${beaten} of ${rivals}`)}">`
            + `<div class="dm-cov-fill${tone}" style="width:${Math.max(3, pct)}%"></div></div>`
            + `<div class="dm-cov-of">${beaten} of ${rivals}</div>`;
    }).join('');
    return cardHtml('Category coverage', `<div class="dm-cov-grid">${body}</div>`);
}

// A ROSTER TOTAL IS NOT A PLAYER'S STAT LINE, and does not carry a stat line's precision. The app's formatStatValue gives three decimals to anything fractional, which on a summed estimate reads as "61.497 errors" - a figure claiming thousandths of an error nobody counted. Whole numbers stay whole, anything at or above one gets a single decimal, and a SUB-ONE figure keeps three because that is what a rate is: a batting average written as "0.3" is not rounded, it is wrong.
function formatCoverageValue(v) {
    if (!Number.isFinite(v)) return '-';
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(3).replace(/^0/, '');
}

function setupStripHtml() {
    const d = mockSetup || mockDefaults();
    mockSetup = d;
    const teams = leagueTeamIds().length || Number(AppState.apiData?.settings?.size) || 0;
    const slots = Array.from({ length: Math.max(1, teams) }, (_, i) => i + 1)
        .map(n => `<option value="${n}"${n === d.slot ? ' selected' : ''}>${n}</option>`).join('');
    const variances = Object.keys(VARIANCE)
        .map(v => `<option value="${v}"${v === d.variance ? ' selected' : ''}>${v}</option>`).join('');
    return `
        <div class="dm-setup">
            <span class="dm-setup-item">${teams} teams</span>
            <label class="dm-setup-item">Your slot <select id="dm-slot" class="dm-select">${slots}</select></label>
            <label class="dm-setup-item">Rounds <input id="dm-rounds" class="dm-num" type="number" min="1" max="60" value="${d.rounds}"></label>
            <label class="dm-setup-item">Bot variance <select id="dm-variance" class="dm-select">${variances}</select></label>
            <label class="dm-setup-item">Draft #<input id="dm-seed" class="dm-num" type="number" value="${d.seed}"></label>
            <button type="button" id="dm-start" class="dm-primary">Start draft</button>
        </div>
    `;
}

function mockFaceHtml() {
    if (!poolHasProjections()) return noProjectionsHtml();
    if (!mock) return setupStripHtml();
    const state = mock.state;
    return `
        ${streamHtml(state)}
        <div class="draft-grid">
            <div class="draft-pool">
                ${spotlightHtml(state)}
                ${poolControlsHtml()}
                ${bestAvailableHtml(state)}
            </div>
            <div class="draft-rail">
                ${rosterCardHtml(state)}
                ${liveScarcityCardHtml(state)}
                ${coverageCardHtml(state)}
            </div>
        </div>
    `;
}

function wireMockFace(container) {
    const start = container.querySelector('#dm-start');
    if (start) {
        start.addEventListener('click', () => {
            mockSetup = {
                slot: Number(container.querySelector('#dm-slot').value) || 1,
                rounds: Math.max(1, Number(container.querySelector('#dm-rounds').value) || 1),
                variance: container.querySelector('#dm-variance').value,
                seed: Number(container.querySelector('#dm-seed').value) || 1
            };
            startMock();
            // The bots ahead of you pick before you ever see the board.
            mock.state = simToTeam(mock.state, mock.userTeamId, botChoice);
            renderDraftTab();
        });
    }
    const restart = container.querySelector('#dm-restart');
    if (restart) restart.addEventListener('click', () => { mock = null; mockSetup = { ...mockDefaults() }; renderDraftTab(); });

    container.querySelectorAll('.dm-alt').forEach(alt => {
        alt.addEventListener('click', () => { spotlightId = Number(alt.dataset.spot); renderDraftTab(); });
    });

    const draft = container.querySelector('#dm-draft');
    if (draft) draft.addEventListener('click', () => {
        draftForUser(Number(draft.dataset.id));
        // The held choice belonged to the pick just spent.
        spotlightId = null;
        renderDraftTab();
    });
    const sim = container.querySelector('#dm-sim');
    if (sim) sim.addEventListener('click', () => { spotlightId = null; advanceBots(); renderDraftTab(); });
    const undo = container.querySelector('#dm-undo');
    if (undo) undo.addEventListener('click', () => { spotlightId = null; undoMock(); renderDraftTab(); });
}

// ==== Export ====

// THE SHEET AS ROWS. Exactly what is on screen, filters included, the way the leaderboard's export works - a sheet exported while a position pill is on is the sheet the manager was reading. The strong categories are written out by name rather than as the strip's squares, because a square is a thing you look at and a spreadsheet is a thing you sort.
export function buildDraftSheetExport() {
    if (!poolHasProjections()) return null;
    const rows = buildBoard();
    const shown = visibleRows(rows);
    const { estimated } = estimateSplit();
    const catIds = Array.from(AppState.scoredStatIds);
    const draftable = draftableCount();

    // THE FIGURES THE BOARD SHOWS, one column per scored category - not the tints. A tint is a way of reading a number at a glance; a spreadsheet is a thing you sort, and it wants the number.
    const headers = ['#', 'Player', 'Pos', 'Value', 'ADP', 'Verdict', 'Kept']
        .concat(categoryNames(catIds));
    const out = shown.map(r => {
        const adp = adpOf(r.player);
        const byId = new Map((r.cells || []).map(c => [c.id, c]));
        return [
            r.boardRank || '',
            r.player.name,
            r.player.positionDisplay || '',
            r.value !== null ? r.value.toFixed(1) : (hasProjection(r.player) ? 'unranked' : 'no projection'),
            adp ? adp.toFixed(1) : '',
            r.boardRank && (!draftable || r.boardRank <= draftable) ? adpVerdict(r.boardRank, adp) : '',
            keptRow(r) ? 'kept' : ''
        ].concat(catIds.map(id => {
            const c = byId.get(id);
            return c && c.value !== null ? formatCellValue(c.value, id, c.estimated) : '';
        }));
    });

    // The estimate is a property of the whole sheet rather than of a row, so it rides the title - which is also what names the downloaded file, so the file says it too.
    const note = estimated.length ? ` (${categoryNames(estimated).join(' and ')} estimated)` : '';
    return { title: `Draft Cheat Sheet${note}`, headers, rows: out };
}

registerExportDataset('draft-sheet', {
    label: 'Draft Cheat Sheet',
    note: 'Exactly as currently shown: search and position filter apply.',
    emptyNote: 'This league\'s pool carries no projections to rank.',
    available: () => poolHasProjections(),
    build: () => buildDraftSheetExport()
});

// The face on screen, named in the theme's own voice. The switcher beside it changes which; this says which you are reading, and is what carries the masthead treatment the tab never had.
function faceTitle() {
    return (FACES.find(f => f.id === activeFace) || FACES[0]).label;
}

// THE MASTHEAD STOPS APOLOGISING. The estimate note has left it: every estimated cell already wears a dotted border and says "estimated from last season" on its own hover, so the header was restating on every page view what the cells state where the figures are. A page-wide caveat for two columns out of fourteen is an apology, not information. The room keeps its line, because a seed and a bot setting are facts about the run that exist nowhere else on the face.
function mastNote() {
    if (activeFace === MOCK_DRAFT && mock) {
        return `Draft #${mock.seed} ${MIDDOT} bots: consensus, ${String(mock.variance).toLowerCase()}`;
    }
    return '';
}

// THE FACE YOU ARE ON IS THE MASTHEAD, so it leaves the chip row. The header was naming it twice - "CHEAT SHEET" in slab beside a chip reading "Cheat sheet" - which is the redundancy the owner's "streamline it" was about. The chips are now the places you can GO, which is what a switcher is.
function faceBarHtml() {
    return FACES.filter(f => f.id !== activeFace).map(f => {
        // The app's own face switcher, not a third tab component. My Team's rules carry the shape; draft-face adds only what differs, which after this is the unbuilt state and nothing else.
        const cls = ['mt-view-tab', 'draft-face', f.ready ? '' : 'draft-face-soon']
            .filter(Boolean).join(' ');
        // The unbuilt faces are inert buttons, not links to nothing - disabled carries the state to a screen reader, and the title says when rather than leaving the reader to guess whether it is broken.
        const soon = f.ready ? '' : ' title="Coming with the NHL draft window"';
        return `<button type="button" class="${cls}" data-face="${f.id}"${f.ready ? '' : ' disabled'}${soon}>`
            + `${escapeHtml(f.label)}</button>`;
    }).join('');
}

// Nothing to rank. Blunt, then the one fact that explains what the face needs - no apology, and no guess about why ESPN has not filed projections for this league's sport yet.
function noProjectionsHtml() {
    // The same state on both faces, in each one's own terms - a reader on the mock draft is not asking about the cheat sheet, and bots that cannot draft should say what they cannot do.
    const why = activeFace === MOCK_DRAFT
        ? "Bots draft off ESPN's season projections. This league's pool doesn't carry them."
        : "The cheat sheet ranks the pool off ESPN's season projections. This league's pool doesn't carry them.";
    return `
        <div class="empty-state draft-empty">
            <div>
                <div class="draft-empty-title">No projections yet.</div>
                <div class="draft-empty-note">${escapeHtml(why)}</div>
            </div>
        </div>
    `;
}

// Three states, and the difference matters to a drafter. A figure. A player ESPN never projected. And a player who HAS a projection the engine still could not score - too little of it to compare, or nothing in the categories this league counts - who is unranked rather than unprojected. The figure is signed only when it is negative. A leading plus across most of a board is noise, but a minus is the whole point of the number: this player is worth LESS than one available for nothing. A DASH RATHER THAN A SENTENCE, because the column is forty-four pixels wide and "no projection" wraps in it - measured as 1527 of 3000 rows standing two pixels taller than their neighbours, which is the uneven row height the owner's screenshot shows. The reason moves to the hover, where there is room for it, and the three states stay distinguishable: a figure, an unranked player, and a player nobody projected.
function valueCell(row) {
    if (row.value !== null) {
        const cls = row.value < 0 ? 'dr-value dr-below' : 'dr-value';
        return `<td class="dr-num ${cls}">${row.value.toFixed(1)}</td>`;
    }
    const why = hasProjection(row.player)
        ? 'Unranked - too little projected to compare'
        : 'No projection for this player';
    return `<td class="dr-num dr-noproj" title="${escapeHtml(why)}">${DASH}</td>`;
}

// ONE CELL PER SCORED CATEGORY: the projected figure, tinted by the percentile that produced it. The tint is the Team Metrics heatmap's, not a second ramp - the same --pct number and the same mix, which is now declared once and shared by all three surfaces that use it (see the tint rule in dashboard.css). Above the middle a cell warms toward success, below it toward danger, and with no percentile at all it sits on the plain surface, which is what "no opinion" looks like. An estimated category wears a dotted border wherever it appears, so a reader can see at a glance which of a player's figures were carried forward rather than forecast. An estimate that could not be made prints a dash rather than a zero - and a category that is not this player's role at all prints nothing, because a pitcher has no home-run line to be bad at. The league's own abbreviations, in its own order.
function categoryHeadsHtml(catIds) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    return catIds.map(id => `<th class="dr-col-cat">${escapeHtml(map[id] || `Stat ${id}`)}</th>`).join('');
}

// AN ESTIMATE DOES NOT GET A PROJECTION'S PRECISION. Real projections come back as counts (43 home runs) or as true rates (.276), and formatStatValue is right for both. An ESTIMATE is a rate carried over games, so it lands fractional on a category that is counted in whole numbers - "7.850 assists" claims thousandths of an assist nobody counted, the same false precision the coverage hover was pulled up for. Counted categories round; rates keep their decimals.
function formatCellValue(value, id, estimated) {
    const rates = AVERAGE_STATS[AppState.loadedSport] || new Set();
    if (estimated && !rates.has(id) && !Number.isInteger(value)) return value.toFixed(1);
    return formatStatValue(value);
}

function categoryCellsHtml(row, catIds) {
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    if (!row.cells) return catIds.map(() => '<td class="dr-cat"></td>').join('');
    return row.cells.map(c => {
        const name = map[c.id] || `Stat ${c.id}`;
        const cls = ['dr-cat'];
        if (c.estimated) cls.push('dr-cat-est');
        if (c.value === null) {
            // Estimated but unreachable is a known blank; off-role is not a blank at all, it is not that column.
            if (!c.estimated) return `<td class="${cls.join(' ')}"></td>`;
            return `<td class="${cls.join(' ')} dr-cat-none" title="${escapeHtml(`${name}: no last season to estimate from`)}">${DASH}</td>`;
        }
        const why = c.pct === null
            ? `${name}: ${formatCellValue(c.value, c.id, c.estimated)}`
            : `${name}: ${formatCellValue(c.value, c.id, c.estimated)}, ${ordinal(c.pct)} percentile`;
        const tail = c.estimated ? ' - estimated from last season' : '';
        const tint = c.pct === null ? '' : ` style="--pct:${percentileVar(c.pct)}"`;
        return `<td class="${cls.join(' ')}"${tint} title="${escapeHtml(why + tail)}">${escapeHtml(String(formatCellValue(c.value, c.id, c.estimated)))}</td>`;
    }).join('');
}

// A full-width rule inside the body, so it scrolls with the players it divides.
function tierRowHtml(note, columns) {
    return `<tr class="dr-tier"><td class="dr-tier-cell" colspan="${columns}">${escapeHtml(note)}</td></tr>`;
}

// A VERDICT ONLY WHERE A VERDICT MEANS SOMETHING. adpVerdict compares a board position against a draft position, and past the last pick neither is a real thing any more - the 900th player is not "a reach" in a league that stops at 88. Scoped to the range the league actually drafts, the same range the tiers use; below it the column is blank rather than wrong. The engine's own tolerance band is untouched, this is the view deciding where to ask. WHO THE PLAYER IS, in one cell: the initials tile, the name, the club and the injury flag. Initials rather than a headshot, by the owner's pick - three thousand rows of photographs is three thousand requests, and the tile is the component the app already uses when one fails. The injury renderer is the app's own; it just had no caller here. A PHOTOGRAPH FOR EVERY PLAYER THIS LEAGUE CAN ACTUALLY TAKE, AND A TILE FOR THE REST. The pipeline is My Team's - a lazy image over an initials tile already in the markup, so a missing photo, an offline preview and a slow network all look the same and none shows a broken glyph. What is new is the bound, and it is here because lazy was not enough on its own. Measured: one render put 1429 img tags on the board, and a single keystroke in the search box rebuilt the rows and cost 1242 more requests. (The 3000 resource entries behind that were not 3000 fetches - ESPN's headshot URLs redirect, so each image logs two - but one fetch per row per render is still a board that costs a thousand requests to filter.) A draft is decided inside the picks the league will actually make, so that is where the photographs are; below it the tile the pipeline already falls back to does the same job for nothing.
function identityCellHtml(p, kept, clubs, action, withPhoto) {
    const club = clubs.get(Number(p.proTeamId));
    const badge = injuryBadgeHtml(p.injuryStatus);
    const playoffs = playoffHoverFor(p, clubs);
    return `<td class="dr-name${kept ? ' dr-kept' : ''}"${playoffs ? ` title="${escapeHtml(playoffs)}"` : ''}>`
        + (withPhoto
            ? buildPlayerAvatarHtml(AppState.loadedSport, p.id, p.name)
            : `<span class="player-avatar"><span class="avatar-initials">${escapeHtml(initialsFor(p.name))}</span></span>`)
        + `<span class="dr-ident"><span class="dr-ident-name">${escapeHtml(p.name)}</span>`
        + (club ? `<span class="dr-club">${escapeHtml(club)}</span>` : '')
        + (badge ? ` ${badge}` : '')
        + (kept ? ' <span class="dr-kept-tag">kept</span>' : '')
        + '</span>'
        + (action || '')
        + '</td>';
}

// THE ADP CELL CARRIES THE DISTANCE, not a word. How far the crowd's pick sits from this board's - "+134" where the board likes a player more than the room does, "-52" where it likes them less, and nothing at all inside the band where the two agree. adpVerdict still decides which of the three it is; its WORD moves to the hover, where a reader who wants the sentence can find it.
function adpCellHtml(row, adp, verdict) {
    if (!adp) return '<td class="dr-num dr-adp"></td>';
    const gap = Math.round(adp - row.boardRank);
    const delta = verdict === 'falling' ? `+${gap}` : (verdict === 'reach' ? String(gap) : '');
    const why = verdict
        ? `${verdict} - ADP ${adp.toFixed(1)}, board #${row.boardRank}`
        : `ADP ${adp.toFixed(1)}, board #${row.boardRank || '-'}`;
    return `<td class="dr-num dr-adp" title="${escapeHtml(why)}">${adp.toFixed(1)}`
        + (delta ? `<span class="dr-delta dr-${verdict}">${escapeHtml(delta)}</span>` : '')
        + '</td>';
}

// The star, and the tier the row belongs to. A queued row says so wherever it appears; the tier rides the rank cell's hover, which is the one cell on the row that is ABOUT the row's place.
function starCellHtml(playerId) {
    const on = queue.has(playerId);
    return `<td class="dr-star-cell"><button type="button" class="dr-star${on ? ' dr-star-on' : ''}"`
        + ` data-queue="${playerId}" title="${on ? 'In your queue' : 'Add to your queue'}"`
        + ` aria-pressed="${on ? 'true' : 'false'}">${on ? STAR_ON : STAR_OFF}</button></td>`;
}

function rowHtml(row, draftable, catIds, clubs, tierNote, edge, showAdp) {
    const p = row.player;
    const adp = adpOf(p);
    const inRange = !!row.boardRank && (!draftable || row.boardRank <= draftable);
    const verdict = inRange ? adpVerdict(row.boardRank, adp) : '';
    return `<tr${edge ? ' class="dr-tier-edge"' : ''}>
        ${starCellHtml(p.id)}
        <td class="dr-num dr-rank"${tierNote ? ` title="${escapeHtml(tierNote)}"` : ''}>${row.boardRank || ''}</td>
        ${identityCellHtml(p, keptRow(row), clubs, '', !!row.boardRank && (!draftable || row.boardRank <= draftable))}
        <td class="dr-num dr-pos" title="${escapeHtml(p.positionDisplay || '')}">${escapeHtml(p.positionDisplay || '')}</td>
        ${valueCell(row)}
        ${showAdp ? adpCellHtml(row, adp, verdict) : ''}
        ${categoryCellsHtml(row, catIds)}
    </tr>`;
}

// The body, dividers included. Tiers are indexed by board position, so they only appear on the unfiltered board - a search or a position pill takes a slice out of the middle of a tier, and a divider over a slice would be describing players who are not on screen. THE BODY: the queue first, then the board. A queued player is pinned above whatever the reader is looking at and taken out of the run below, so the list the reader built stays together under any search or pill instead of scattering into three thousand rows. Tier RULES are only drawn on an unbroken board - a rule over a filtered slice would be describing players who are not on screen - but every row keeps its tier on the rank cell, and the first row of each tier in a filtered view takes a left edge, so the shape of the board survives the filter even when its dividers cannot.
function tableBodyHtml(rows, shown, columns) {
    const filtered = shown.length !== rows.length;
    const { noteByIndex, noteById } = tierIndex(rows);
    const draftable = draftableCount();
    const catIds = Array.from(AppState.scoredStatIds);
    const clubs = proTeamAbbrevs();
    const showAdp = poolHasAdp();

    const queued = rows.filter(r => queue.has(r.player.id));
    const queuedIdSet = new Set(queued.map(r => r.player.id));
    let out = '';
    if (queued.length) {
        out += `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">`
            + `Queue ${MIDDOT} ${queued.length}</td></tr>`;
        out += queued.map(r => rowHtml(r, draftable, catIds, clubs, noteById.get(r.player.id), false, showAdp)).join('');
        out += `<tr class="dr-section"><td class="dr-section-cell" colspan="${columns}">Board</td></tr>`;
    }

    let rankedSeen = 0;
    let lastTier = null;
    out += shown.map(r => {
        const note = noteById.get(r.player.id) || '';
        let head = '';
        let edge = false;
        if (r.value !== null) {
            if (!filtered && noteByIndex.has(rankedSeen)) head = tierRowHtml(noteByIndex.get(rankedSeen), columns);
            if (filtered && note && note !== lastTier) edge = true;
            lastTier = note;
            rankedSeen++;
        }
        if (queuedIdSet.has(r.player.id)) return head;
        return head + rowHtml(r, draftable, catIds, clubs, note, edge, showAdp);
    }).join('');
    return out;
}

// The search and pills, shared by both faces - the room needed them and did not have them, and a reader who filters the sheet then switches face should not lose that filter.
function poolControlsHtml(basisNote) {
    const pills = positionPills().map(pos =>
        `<button type="button" class="dr-pill${pos === posFilter ? ' active' : ''}" data-pos="${escapeHtml(pos)}">${escapeHtml(pos)}</button>`
    ).join('');
    return `
        <div class="dr-controls">
            <input type="search" id="draft-search" class="dr-search" placeholder="Search" value="${escapeHtml(poolSearch)}">
            <div class="dr-pills">${pills}</div>
            ${basisNote ? `<span class="dr-basis">${escapeHtml(basisNote)}</span>` : ''}
        </div>
    `;
}

function cheatSheetHtml() {
    if (!poolHasProjections()) return noProjectionsHtml();

    const rows = buildBoard();
    const shown = visibleRows(rows);
    const catIds = Array.from(AppState.scoredStatIds);

    return `
        <div class="draft-grid">
            <div class="draft-pool">
                ${poolControlsHtml("Value: ESPN projections over replacement, your league's scoring")}
                <div class="dr-scroll">
                    <table class="dr-table">
                        <thead><tr>
                            <th class="dr-col-star" title="Queue"></th>
                            <th class="dr-col-rank">#</th>
                            <th class="dr-col-name">Player</th>
                            <th class="dr-col-pos">Pos</th>
                            <th class="dr-col-value" title="The edge over the last starter at that position group, added up across every category your league scores. 0 is a player you could have anyway.">Value</th>
                            ${poolHasAdp() ? '<th class="dr-col-adp" title="Where the crowd drafts this player, and how far that sits from this board.">ADP</th>' : ''}
                            ${categoryHeadsHtml(catIds)}
                        </tr></thead>
                        <tbody>${tableBodyHtml(rows, shown, 5 + (poolHasAdp() ? 1 : 0) + catIds.length)}</tbody>
                    </table>
                </div>
            </div>
            ${railHtml(rows)}
        </div>
    `;
}

export function renderDraftTab() {
    const container = document.getElementById('draft-container');
    if (!container) return;

    if (!AppState.apiData) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="draft-mast">
            <span class="draft-mast-title">${escapeHtml(faceTitle())}</span>
            ${queue.size ? `<span class="draft-mast-count">Queue ${queue.size}</span>` : ''}
            <div class="draft-faces">${faceBarHtml()}</div>
            ${activeFace === MOCK_DRAFT && mock ? '<button type="button" id="dm-restart" class="dm-flat">Restart</button>' : ''}
            <span class="draft-mast-note">${escapeHtml(mastNote())}</span>
            <div class="draft-head-line">${(() => {
                const inRoom = activeFace === MOCK_DRAFT && mock;
                const parts = inRoom ? mockStateLine(mock.state) : headerLine();
                const yours = inRoom && mockStateIsYours(mock.state);
                return parts.map((p, i) => {
                    const own = yours && i === parts.length - 1;
                    return `<span${own ? ' class="draft-head-you"' : ''}>${escapeHtml(String(p))}</span>`;
                }).join('<span class="draft-head-sep">·</span>');
            })()}</div>
        </div>
        <div id="draft-face-body" class="draft-face-body">${activeFace === MOCK_DRAFT ? mockFaceHtml() : cheatSheetHtml()}</div>
    `;

    wireDraftTab(container);
}

// Re-rendering the whole face on every keystroke would lose focus and the caret, so the search box redraws only the rows beneath it and leaves itself alone.
function redrawRows() {
    const body = document.querySelector('.dr-table tbody');
    if (!body) return;
    const rows = buildBoard();
    body.innerHTML = tableBodyHtml(rows, visibleRows(rows), 5 + (poolHasAdp() ? 1 : 0) + AppState.scoredStatIds.size);
}

function wireDraftTab(container) {
    container.querySelectorAll('.draft-face:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            const face = btn.dataset.face;
            if (face === activeFace) return;
            activeFace = face;
            renderDraftTab();
        });
    });

    const exportBtn = container.querySelector('#draft-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', () => openExportModal());

    wireMockFace(container);

    // Delegated, because the rows are replaced wholesale on every search keystroke and a handler bound to a row would be thrown away with it. BOUND ONCE, and the flag is the whole point. Every other handler here hangs off an element that renderDraftTab replaces, so they die with their markup; this one hangs off the CONTAINER, which survives. Re-binding it per render stacked handlers - two after the first star, three after the second - so a click toggled the queue two and three times and the star appeared not to work. Measured as one queued player out of three.
    if (!container.dataset.queueWired) {
        container.dataset.queueWired = '1';
        container.addEventListener('click', (e) => {
            const star = e.target.closest('.dr-star');
            if (!star) return;
            const id = Number(star.dataset.queue);
            if (queue.has(id)) queue.delete(id); else queue.add(id);
            renderDraftTab();
        });
    }

    // A row's own Draft control goes through the same path the banner's does, so undo covers it exactly as it covers a spotlight pick - one stack, one history.
    container.querySelectorAll('.dm-rowdraft').forEach(btn => {
        btn.addEventListener('click', () => {
            draftForUser(Number(btn.dataset.draft));
            spotlightId = null;
            renderDraftTab();
        });
    });

    // The headshots are lazy, so this only wires what is drawn.
    wirePlayerAvatars(container);

    const search = container.querySelector('#draft-search');
    if (search) search.addEventListener('input', () => { poolSearch = search.value; redrawRows(); });

    container.querySelectorAll('.dr-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            posFilter = pill.dataset.pos;
            container.querySelectorAll('.dr-pill').forEach(p => p.classList.toggle('active', p === pill));
            redrawRows();
        });
    });
}
