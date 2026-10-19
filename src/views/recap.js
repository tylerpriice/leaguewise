/**
 * The shareable weekly league recap: a branded canvas image and a text block for one matchup week,
 * made to be posted into a league group chat. A recap covers the whole league (results, the
 * blowout and the closest game, team of the week, standings with movement) or one team's
 * head-to-head with a category-by-category breakdown.
 *
 * The model and text builders read application state and return plain data. The canvas renderers
 * and the modal own the presentation. Sharing uses the Web Share API where it exists. Elsewhere the
 * modal offers copying the text, copying the image or downloading the PNG.
 *
 * @module recap
 */
/**
 * One side of a matchup as the recap prints it.
 * @typedef {Object} RecapSide
 * @property {number|string} id Team id.
 * @property {string} name Team name.
 * @property {string} color Team colour.
 * @property {number} value Wins plus half the ties in a category league, points scored in a points league.
 * @property {string} scoreStr The score as printed, W-L-T or points to one decimal.
 */
/**
 * One scheduled game in a recap week.
 * @typedef {Object} RecapResult
 * @property {RecapSide} home
 * @property {RecapSide} away
 * @property {RecapSide|null} winner Null for a tie or an undecided game.
 * @property {RecapSide|null} loser Null for a tie or an undecided game.
 * @property {boolean} decided
 * @property {boolean} tie
 * @property {number} margin Absolute difference between the two values.
 */
/**
 * The league recap for one matchup week, from buildRecapModel.
 * @typedef {Object} RecapModel
 * @property {'league'} kind
 * @property {string} leagueName
 * @property {string|number} seasonId
 * @property {number} week
 * @property {boolean} isPoints
 * @property {boolean} inProgress True while any game in the week is undecided.
 * @property {RecapResult[]} results
 * @property {RecapResult|null} blowout
 * @property {RecapResult|null} nailbiter The closest game, null when the week has ties instead.
 * @property {RecapResult[]} ties
 * @property {{name: string, color: string, value: number}|null} teamOfWeek
 * @property {Object[]} standings Cumulative standings with rank, record, detail and signed move.
 * @property {string} shareTitle
 * @property {string} filenameBase
 */
/**
 * One team's head-to-head for a matchup week, from buildTeamMatchupRecapModel.
 * @typedef {Object} TeamRecapModel
 * @property {'team'} kind
 * @property {boolean} [noGame] True when the team had no matchup that week.
 * @property {string} leagueName
 * @property {string|number} seasonId
 * @property {number} week
 * @property {string} [teamName] Set only when noGame is true.
 * @property {boolean} inProgress
 * @property {boolean} [isPoints]
 * @property {RecapSide} [me]
 * @property {RecapSide} [opp]
 * @property {boolean} [decided]
 * @property {boolean} [tie]
 * @property {'W'|'L'|'T'|'?'} [result]
 * @property {Object[]} [categories] One row per scored category: id, name, myVal, oppVal, inverse, winnerSide and groupBreakBefore.
 * @property {number} [catsWon]
 * @property {number} [catsLost]
 * @property {number} [catsTied]
 * @property {string} shareTitle
 * @property {string} filenameBase
 */

import { AppState, ESPN_STAT_MAPS, leagueInverseIds } from '../data/state.js';
import { escapeHtml, orderStatIdsByRole, splitStatIdsByRole, matchupTally, matchupPoints } from './utils.js';
// The closest-game reduction lives in history.js so the season card and this recap cannot disagree about which game was closest.
import { matchupExtremes } from '../engines/history.js';

const BRAND_NAME = 'Leaguewise';
// The brand's card-copy line (brand/BRAND.md), docs/POSITIONING.md's words exactly, on two lines.
const BRAND_TAGLINE_1 = 'League analytics for ESPN Fantasy Baseball, Football and Hockey.';
const BRAND_TAGLINE_2 = 'Your league data never leaves your browser.';
const FONT_STACK = '"Segoe UI", Roboto, Arial, sans-serif';

// The canvas image has its own fixed palette. It is exported and posted into chats rather than viewed in the app, so it stays light and branded in both themes. The brand values are literals here and nowhere else.
const P = {
    white: '#ffffff',
    navy: '#1b2b4b',               // the head-to-head image's centre score
    brandTile: '#101112',          // BRAND.md "Tile"
    brandW: '#cdab58',             // "W"
    brandDot: '#efe9dc',           // "Dot", and the wordmark on a dark ground
    brandHairline: '#5c6169',      // "Tile hairline": lifts the tile off a near-black band
    brandTagline: '#9a978f',       // "Tagline on dark"
    headerSub: '#bcd2f7',
    title: '#222222',
    textStrong: '#1a1a1a',
    text: '#444444',
    textMuted: '#667080',
    catName: '#333333',
    textFaint: '#8a94a1',
    textFaint2: '#9aa3af',
    divider: '#e5e8ec',
    sectionLabel: '#6b7280',
    cardBg: '#f5f8fc',
    cardBorder: '#e1e8f2',
    zebra: '#f8fafc',
    accent: '#007bff',
    positive: '#1d8a3e',
    negative: '#c62828',
    teamFallback: '#888888'
};

// ==== Recap model ====

/**
 * The latest matchup week in which every scheduled game has a decided winner, which is the natural
 * default for a recap. Falls back to the latest completed week when none has fully finished.
 * @returns {number} A matchup period id.
 */
export function defaultRecapWeek() {
    const schedule = AppState.apiData?.schedule || [];
    const byWeek = new Map();
    schedule.forEach(g => {
        if (!g.home || !g.away) return;
        if (!byWeek.has(g.matchupPeriodId)) byWeek.set(g.matchupPeriodId, true);
        if (!g.winner || g.winner === 'UNDECIDED') byWeek.set(g.matchupPeriodId, false);
    });
    let lastCompleted = 0;
    byWeek.forEach((complete, week) => {
        if (complete && week > lastCompleted && week <= AppState.maxCompletedWeek) lastCompleted = week;
    });
    return lastCompleted || AppState.maxCompletedWeek;
}

// Cumulative standings through a week, ordered by matchups won with points and then category wins as tiebreaks. A points league keeps its points total beside the record.
function standingsThrough(thruWeek, isPoints) {
    return AppState.teamStats.map(t => {
        let matchWins = 0, points = 0, cWins = 0, w = 0, l = 0, ties = 0;
        for (let wk = 1; wk <= thruWeek; wk++) {
            const val = t.weeklyMatchWins[wk];
            if (val === undefined) continue;
            if (isPoints) points += val;
            // A playoff bye is not a game and belongs in no record.
            if (t.weeklyBye?.[wk]) continue;
            // A week with no result is not a loss. A points league holds points in weeklyMatchWins and the result is withheld for a week nobody has played.
            const result = isPoints ? t.weeklyMatchResult[wk] : val;
            if (result === undefined) continue;
            matchWins += result;
            cWins += t.weeklyCatWins[wk] || 0;
            if (result === 1) w++; else if (result === 0.5) ties++; else l++;
        }
        return {
            id: t.id,
            name: t.name,
            color: AppState.teamColorMap[t.id] || '#888',
            mWins: matchWins, cWins, points,
            record: `${w}-${l}-${ties}`,
            // The secondary number each format is ranked by after the record, shown beside it.
            detail: isPoints ? `${Math.round(points)} pts` : null
        };
    }).sort((a, b) => (b.mWins - a.mWins) || (b.points - a.points) || (b.cWins - a.cWins) || a.name.localeCompare(b.name));
}

/**
 * Builds the league recap for one matchup week: results, the blowout and the closest game, team of
 * the week and standings with movement.
 * @param {number} week A matchup period id.
 * @returns {RecapModel|null} Null when no league is loaded or no week is given.
 */
export function buildRecapModel(week) {
    const data = AppState.apiData;
    if (!data || !week) return null;
    const isPoints = AppState.isPointsLeague;
    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });

    const games = (data.schedule || []).filter(g => g.matchupPeriodId === week && g.home && g.away);
    const results = games.map(g => {
        const side = (key) => {
            const id = g[key].teamId;
            const team = teamById[id];
            let value, scoreStr;
            if (isPoints) {
                value = matchupPoints(g[key]);
                scoreStr = value.toFixed(1);
            } else {
                const tally = matchupTally(g[key]);
                const wins = tally?.wins || 0;
                const losses = tally?.losses || 0;
                const ties = tally?.ties || 0;
                value = wins + ties * 0.5;
                scoreStr = `${wins}-${losses}-${ties}`;
            }
            return {
                id,
                name: team ? team.name : `Team ${id}`,
                color: AppState.teamColorMap[id] || '#888',
                value, scoreStr
            };
        };
        const home = side('home');
        const away = side('away');
        const decided = !!g.winner && g.winner !== 'UNDECIDED';
        const tie = g.winner === 'TIE';
        const winner = g.winner === 'HOME' ? home : (g.winner === 'AWAY' ? away : null);
        const loser = winner ? (winner === home ? away : home) : null;
        return { home, away, winner, loser, decided, tie, margin: Math.abs(home.value - away.value) };
    });

    // The closest-game reduction lives in history.js and is shared with the season card. A tie is the closest game, so a week with one reports ties and no closest game, and callers read both.
    const { blowout, closest: nailbiter, ties } = matchupExtremes(results);

    // Team of the week is the best single-week production: category wins in a category league, raw points in a points league.
    const weekValOf = t => isPoints ? (t.weeklyMatchWins[week] || 0) : (t.weeklyCatWins[week] || 0);
    let teamOfWeek = null;
    AppState.teamStats.forEach(t => {
        const val = weekValOf(t);
        if (val > 0 && (!teamOfWeek || val > teamOfWeek.value)) {
            teamOfWeek = { name: t.name, color: AppState.teamColorMap[t.id] || '#888', value: val };
        }
    });

    const standingsNow = standingsThrough(week, isPoints);
    const prevRankById = new Map(standingsThrough(week - 1, isPoints).map((s, i) => [s.id, i + 1]));
    const standings = standingsNow.map((s, i) => ({
        ...s,
        rank: i + 1,
        // Positive = climbed. Week 1 has no "previous standings" to move from.
        move: week > 1 ? (prevRankById.get(s.id) || (i + 1)) - (i + 1) : 0
    }));

    const leagueName = data.settings?.name || 'My League';
    return {
        kind: 'league',
        leagueName,
        seasonId: data.seasonId || '',
        week,
        isPoints,
        inProgress: results.some(r => !r.decided),
        results, blowout, nailbiter, ties, teamOfWeek, standings,
        shareTitle: `${leagueName}: Matchup ${week} Recap`,
        filenameBase: `${leagueName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-matchup-${week}-recap`
    };
}

// Dispatch by recap kind so the modal's rebuild/share/copy/download paths stay identical for both the whole-league recap and a single team's head-to-head.
function recapTextOf(m) {
    return m.kind === 'team' ? buildTeamMatchupText(m) : buildRecapText(m);
}
function renderRecapImageOf(m) {
    return m.kind === 'team' ? renderTeamMatchupImage(m) : renderRecapImage(m);
}

// ==== Text block ====

function resultLine(r, isPoints) {
    const score = isPoints && r.winner ? `${r.winner.scoreStr}-${r.loser.scoreStr}` : (r.winner ? r.winner.scoreStr : '');
    if (r.tie) return `🤝 ${r.home.name} tied ${r.away.name} (${r.home.scoreStr})`;
    if (!r.decided) {
        if (r.home.value === r.away.value) return `⏳ ${r.home.name} and ${r.away.name} are tied (${r.home.scoreStr})`;
        const lead = r.home.value > r.away.value ? r.home : r.away;
        const trail = lead === r.home ? r.away : r.home;
        return `⏳ ${lead.name} leads ${trail.name} (${lead.scoreStr})`;
    }
    return `✅ ${r.winner.name} def. ${r.loser.name} (${score})`;
}

/**
 * The tie line's words, defined once so the text block and the image cannot say different things
 * about the same week. The count is a digit, like every score around it, and no matchup number is
 * printed because a weekly recap is already one matchup.
 * @param {RecapResult[]|null|undefined} ties The tied games of the week.
 * @returns {string|null} A line such as "1 tie: A v B", or null when there are none.
 */
export function tiesText(ties) {
    if (!ties || !ties.length) return null;
    const pairs = ties.map(r => `${r.home.name} v ${r.away.name}`).join(', ');
    return `${ties.length} tie${ties.length === 1 ? '' : 's'}: ${pairs}`;
}

/**
 * The recap as plain text for a chat: results, highlights and standings with movement.
 * @param {RecapModel} m A model from buildRecapModel.
 * @returns {string}
 */
export function buildRecapText(m) {
    const lines = [];
    lines.push(`🏆 ${m.leagueName}: Matchup ${m.week} Recap${m.inProgress ? ' (in progress)' : ''}`);
    if (m.results.length) {
        lines.push('');
        m.results.forEach(r => lines.push(resultLine(r, m.isPoints)));
    }
    const highlights = [];
    if (m.blowout) highlights.push(`💥 Blowout: ${m.blowout.winner.name} over ${m.blowout.loser.name} (${m.blowout.winner.scoreStr})`);
    if (m.nailbiter) highlights.push(`😬 Nail-biter: ${m.nailbiter.winner.name} edged ${m.nailbiter.loser.name} (${m.nailbiter.winner.scoreStr})`);
    // Exclusive with the nail-biter by matchupExtremes' own rule, never both: a week with a tie has no closest game left to name, because the tie IS it.
    if (m.ties && m.ties.length) highlights.push(`🤝 ${tiesText(m.ties)}`);
    if (m.teamOfWeek) highlights.push(`⭐ Team of the Week: ${m.teamOfWeek.name} (${m.isPoints ? m.teamOfWeek.value.toFixed(1) + ' pts' : m.teamOfWeek.value + ' category wins'})`);
    if (highlights.length) {
        lines.push('');
        highlights.forEach(h => lines.push(h));
    }
    if (m.standings.length) {
        lines.push('', '📊 Standings:');
        m.standings.forEach(s => {
            const move = s.move > 0 ? ` ▲${s.move}` : (s.move < 0 ? ` ▼${-s.move}` : '');
            lines.push(`${s.rank}. ${s.name} (${s.record}${s.detail ? `, ${s.detail}` : ''})${move}`);
        });
    }
    lines.push('', `📈 Made with ${BRAND_NAME}`);
    return lines.join('\n');
}

// ==== Image ====

function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = String(text);
    while (t.length > 1 && ctx.measureText(t + '...').width > maxWidth) t = t.slice(0, -1);
    return t + '...';
}

function dot(ctx, x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// The brand mark on its tile, drawn from BRAND.md's own geometry for the tile drawing (48 units: tile radius 10, the polyline, stroke 5.4 with round caps and joins, the dot at 41,13 radius 4.6), scaled to `size`. The band is the tile's own colour, so the tile is told apart by its hairline. Drawn, not an image asset, so the extension ships no extra files and the canvas needs no async loads.
function drawBrandMark(ctx, x, y, size) {
    const u = size / 48;
    roundRect(ctx, x, y, size, size, 10 * u);
    ctx.fillStyle = P.brandTile;
    ctx.fill();
    ctx.strokeStyle = P.brandHairline;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const pts = [[7, 17], [17, 35.5], [24, 22.5], [31, 35.5], [41, 13]];
    ctx.beginPath();
    pts.forEach(([px, py], i) => {
        const cx = x + px * u, cy = y + py * u;
        i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    });
    ctx.strokeStyle = P.brandW;
    ctx.lineWidth = 5.4 * u;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x + 41 * u, y + 13 * u, 4.6 * u, 0, Math.PI * 2);
    ctx.fillStyle = P.brandDot;
    ctx.fill();
}

// THE WORDMARK, as paths: "League" and "ise" outlined from DejaVu Sans Bold, exactly the letters of brand/lockup-on-dark.svg (about 4 KB of path data, small enough to carry here, so the image needs neither a font nor a fetch and reads the same on every machine). The W of the name is the mark, drawn between them from its 24-unit geometry. The lockup's baseline is y = 0 of these units.
const LOCKUP_LEAGUE = new Path2D('M-301.5 -65.61H-284.58V-12.79H-254.87V0H-301.5ZM-195.72 -24.74V-20.26H-232.5Q-231.93 -14.72 -228.5 -11.95Q-225.08 -9.18 -218.92 -9.18Q-213.96 -9.18 -208.75 -10.66Q-203.54 -12.13 -198.05 -15.12V-2.99Q-203.63 -0.88 -209.21 0.2Q-214.79 1.27 -220.37 1.27Q-233.73 1.27 -241.14 -5.52Q-248.54 -12.3 -248.54 -24.57Q-248.54 -36.61 -241.27 -43.51Q-234 -50.41 -221.25 -50.41Q-209.65 -50.41 -202.69 -43.42Q-195.72 -36.43 -195.72 -24.74ZM-211.89 -29.97Q-211.89 -34.45 -214.51 -37.2Q-217.12 -39.95 -221.34 -39.95Q-225.91 -39.95 -228.77 -37.38Q-231.62 -34.8 -232.33 -29.97ZM-161.75 -22.15Q-166.67 -22.15 -169.16 -20.48Q-171.64 -18.81 -171.64 -15.56Q-171.64 -12.57 -169.64 -10.88Q-167.64 -9.18 -164.08 -9.18Q-159.64 -9.18 -156.61 -12.37Q-153.58 -15.56 -153.58 -20.35V-22.15ZM-137.71 -28.08V0H-153.58V-7.29Q-156.74 -2.81 -160.7 -0.77Q-164.65 1.27 -170.32 1.27Q-177.97 1.27 -182.73 -3.19Q-187.5 -7.65 -187.5 -14.77Q-187.5 -23.42 -181.55 -27.47Q-175.59 -31.51 -162.85 -31.51H-153.58V-32.74Q-153.58 -36.47 -156.52 -38.21Q-159.47 -39.95 -165.71 -39.95Q-170.76 -39.95 -175.11 -38.94Q-179.46 -37.92 -183.2 -35.9V-47.9Q-178.14 -49.13 -173.04 -49.77Q-167.95 -50.41 -162.85 -50.41Q-149.53 -50.41 -143.62 -45.15Q-137.71 -39.9 -137.71 -28.08ZM-89.59 -8.35Q-92.84 -4.04 -96.76 -2.02Q-100.67 0 -105.81 0Q-114.82 0 -120.71 -7.1Q-126.59 -14.19 -126.59 -25.18Q-126.59 -36.21 -120.71 -43.26Q-114.82 -50.32 -105.81 -50.32Q-100.67 -50.32 -96.76 -48.3Q-92.84 -46.27 -89.59 -41.92V-49.22H-73.77V-4.97Q-73.77 6.9 -81.26 13.16Q-88.76 19.42 -103 19.42Q-107.61 19.42 -111.92 18.72Q-116.22 18.02 -120.57 16.57V4.31Q-116.44 6.68 -112.49 7.84Q-108.53 9.01 -104.53 9.01Q-96.8 9.01 -93.2 5.62Q-89.59 2.24 -89.59 -4.97ZM-99.96 -38.98Q-104.84 -38.98 -107.57 -35.38Q-110.29 -31.77 -110.29 -25.18Q-110.29 -18.41 -107.65 -14.92Q-105.02 -11.43 -99.96 -11.43Q-95.04 -11.43 -92.32 -15.03Q-89.59 -18.63 -89.59 -25.18Q-89.59 -31.77 -92.32 -35.38Q-95.04 -38.98 -99.96 -38.98ZM-59.18 -19.16V-49.22H-43.36V-44.3Q-43.36 -40.3 -43.41 -34.26Q-43.45 -28.21 -43.45 -26.19Q-43.45 -20.26 -43.14 -17.64Q-42.83 -15.03 -42.09 -13.84Q-41.12 -12.3 -39.56 -11.47Q-38 -10.63 -35.98 -10.63Q-31.06 -10.63 -28.24 -14.41Q-25.43 -18.19 -25.43 -24.92V-49.22H-9.7V0H-25.43V-7.12Q-28.99 -2.81 -32.97 -0.77Q-36.95 1.27 -41.74 1.27Q-50.26 1.27 -54.72 -3.96Q-59.18 -9.18 -59.18 -19.16ZM54.55 -24.74V-20.26H17.77Q18.34 -14.72 21.77 -11.95Q25.19 -9.18 31.35 -9.18Q36.31 -9.18 41.52 -10.66Q46.73 -12.13 52.22 -15.12V-2.99Q46.64 -0.88 41.06 0.2Q35.48 1.27 29.9 1.27Q16.54 1.27 9.13 -5.52Q1.73 -12.3 1.73 -24.57Q1.73 -36.61 9 -43.51Q16.27 -50.41 29.02 -50.41Q40.62 -50.41 47.58 -43.42Q54.55 -36.43 54.55 -24.74ZM38.38 -29.97Q38.38 -34.45 35.76 -37.2Q33.15 -39.95 28.93 -39.95Q24.36 -39.95 21.5 -37.38Q18.65 -34.8 17.94 -29.97Z');
const LOCKUP_ISE = new Path2D('M171.86 -49.22H187.59V0H171.86ZM171.86 -68.38H187.59V-55.55H171.86ZM241.16 -47.68V-35.73Q236.11 -37.84 231.4 -38.89Q226.7 -39.95 222.53 -39.95Q218.04 -39.95 215.87 -38.83Q213.69 -37.71 213.69 -35.38Q213.69 -33.49 215.34 -32.48Q216.99 -31.46 221.25 -30.98L224.02 -30.59Q236.11 -29.05 240.28 -25.53Q244.46 -22.02 244.46 -14.5Q244.46 -6.64 238.65 -2.68Q232.85 1.27 221.34 1.27Q216.46 1.27 211.25 0.51Q206.05 -0.26 200.55 -1.8V-13.75Q205.26 -11.47 210.2 -10.33Q215.14 -9.18 220.24 -9.18Q224.86 -9.18 227.18 -10.46Q229.51 -11.73 229.51 -14.24Q229.51 -16.35 227.91 -17.38Q226.31 -18.41 221.52 -18.98L218.75 -19.34Q208.24 -20.65 204.03 -24.21Q199.81 -27.77 199.81 -35.02Q199.81 -42.85 205.17 -46.63Q210.53 -50.41 221.6 -50.41Q225.95 -50.41 230.74 -49.75Q235.53 -49.09 241.16 -47.68ZM305.41 -24.74V-20.26H268.63Q269.2 -14.72 272.62 -11.95Q276.05 -9.18 282.2 -9.18Q287.17 -9.18 292.38 -10.66Q297.59 -12.13 303.08 -15.12V-2.99Q297.5 -0.88 291.92 0.2Q286.34 1.27 280.75 1.27Q267.39 1.27 259.99 -5.52Q252.59 -12.3 252.59 -24.57Q252.59 -36.61 259.86 -43.51Q267.13 -50.41 279.88 -50.41Q291.48 -50.41 298.44 -43.42Q305.41 -36.43 305.41 -24.74ZM289.24 -29.97Q289.24 -34.45 286.62 -37.2Q284.01 -39.95 279.79 -39.95Q275.22 -39.95 272.36 -37.38Q269.5 -34.8 268.8 -29.97Z');
const LOCKUP_LEFT = -301.5;      // where "League" starts, in lockup units
const LOCKUP_RIGHT = 301.5;      // where "ise" ends: the lockup is centred on 0, so its ink ends where it begins, mirrored
const LOCKUP_CAP = 65.61;        // the height of the L, in lockup units

// The lockup with its left edge at x and its baseline at `baseline`, `cap` pixels from the baseline to the top of the L. Returns its drawn width.
function drawLockup(ctx, x, baseline, cap) {
    const k = cap / LOCKUP_CAP;
    ctx.save();
    ctx.translate(x - LOCKUP_LEFT * k, baseline);
    ctx.scale(k, k);
    ctx.fillStyle = P.brandDot;
    ctx.fill(LOCKUP_LEAGUE);
    ctx.fill(LOCKUP_ISE);
    ctx.translate(64.30, -66.65);
    ctx.scale(4.3, 4.3);
    ctx.translate(-1.4, -3.6);
    ctx.beginPath();
    [[3, 8], [8, 17.5], [12, 10.5], [16, 17.5], [21, 6]].forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    ctx.strokeStyle = P.brandW;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(21, 6, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = P.brandDot;
    ctx.fill();
    ctx.restore();
    return (LOCKUP_RIGHT - LOCKUP_LEFT) * k;
}

// The footer strip, in both images: the tile's near-black, the lockup in its own colours and the card-copy line the social card and README banner carry (brand/BRAND.md "The card copy"), on two lines.
function drawBrandFooter(ctx, height) {
    ctx.fillStyle = P.brandTile;
    ctx.fillRect(0, height - FOOTER_H, IMG_W, FOOTER_H);
    const fy = height - FOOTER_H / 2;
    const w = drawLockup(ctx, PAD, fy + 15, 30);
    ctx.fillStyle = P.brandTagline;
    ctx.font = `400 16px ${FONT_STACK}`;
    ctx.fillText(BRAND_TAGLINE_1, PAD + w + 28, fy - 11);
    ctx.fillText(BRAND_TAGLINE_2, PAD + w + 28, fy + 11);
}

// Section layout constants shared by the height precompute and the actual drawing.
const IMG_W = 1080;
const PAD = 56;
const HEADER_H = 168;
const SECTION_TITLE_H = 64;
const RESULT_ROW_H = 58;
const CARDS_H = 140;
const STANDING_ROW_H = 50;
const FOOTER_H = 88;
const SECTION_GAP = 26;

function renderRecapImage(m) {
    const cards = [
        m.blowout && { emoji: '💥', label: 'BLOWOUT', name: m.blowout.winner.name, sub: `over ${m.blowout.loser.name} (${m.blowout.winner.scoreStr})`, color: m.blowout.winner.color },
        m.nailbiter && { emoji: '😬', label: 'NAIL-BITER', name: m.nailbiter.winner.name, sub: `edged ${m.nailbiter.loser.name} (${m.nailbiter.winner.scoreStr})`, color: m.nailbiter.winner.color },
        // Takes the nail-biter's slot rather than adding a fourth card, and can: the two are exclusive by matchupExtremes' own rule, so this row never grows past three and the card width never changes. A single tie names the pairing; several name the count, and the pairings go in the sub-line where fitText clips them to the card.
        (m.ties && m.ties.length) && {
            emoji: '🤝',
            label: m.ties.length > 1 ? 'TIES' : 'TIE',
            name: m.ties.length > 1 ? `${m.ties.length} matchups tied` : `${m.ties[0].home.name} v ${m.ties[0].away.name}`,
            sub: m.ties.length > 1
                ? m.ties.map(r => `${r.home.name} v ${r.away.name}`).join(', ')
                : `tied ${m.ties[0].home.scoreStr}`,
            color: m.ties[0].home.color
        },
        m.teamOfWeek && { emoji: '⭐', label: 'TEAM OF THE WEEK', name: m.teamOfWeek.name, sub: m.isPoints ? `${m.teamOfWeek.value.toFixed(1)} points` : `${m.teamOfWeek.value} category wins`, color: m.teamOfWeek.color }
    ].filter(Boolean);

    const resultsBlockH = m.results.length ? SECTION_TITLE_H + m.results.length * RESULT_ROW_H + SECTION_GAP : 0;
    const cardsBlockH = cards.length ? CARDS_H + SECTION_GAP : 0;
    const standingsBlockH = m.standings.length ? SECTION_TITLE_H + m.standings.length * STANDING_ROW_H + SECTION_GAP : 0;
    const height = HEADER_H + SECTION_GAP + resultsBlockH + cardsBlockH + standingsBlockH + FOOTER_H;

    const canvas = document.createElement('canvas');
    canvas.width = IMG_W;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'middle';

    // Background
    ctx.fillStyle = P.white;
    ctx.fillRect(0, 0, IMG_W, height);

    // Header band
    ctx.fillStyle = P.brandTile;
    ctx.fillRect(0, 0, IMG_W, HEADER_H);

    drawBrandMark(ctx, PAD, 44, 80);
    ctx.fillStyle = P.white;
    ctx.font = `700 44px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, m.leagueName, IMG_W - PAD * 2 - 110), PAD + 108, 74);
    ctx.fillStyle = P.headerSub;
    ctx.font = `600 26px ${FONT_STACK}`;
    ctx.fillText(`Matchup ${m.week} Recap${m.seasonId ? ` • ${m.seasonId}` : ''}${m.inProgress ? '  (in progress)' : ''}`, PAD + 108, 118);

    let y = HEADER_H + SECTION_GAP;

    const sectionTitle = (text) => {
        ctx.fillStyle = P.title;
        ctx.font = `700 26px ${FONT_STACK}`;
        ctx.fillText(text, PAD, y + 26);
        ctx.strokeStyle = P.divider;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(PAD, y + 48);
        ctx.lineTo(IMG_W - PAD, y + 48);
        ctx.stroke();
        y += SECTION_TITLE_H;
    };

    // Results
    if (m.results.length) {
        sectionTitle('Results');
        m.results.forEach(r => {
            const cy = y + RESULT_ROW_H / 2;
            const first = r.winner || (r.home.value >= r.away.value ? r.home : r.away);
            const second = first === r.home ? r.away : r.home;
            const verb = r.tie ? 'tied' : (r.decided ? 'def.' : 'leads');

            dot(ctx, PAD + 8, cy, 8, first.color);
            ctx.font = `700 25px ${FONT_STACK}`;
            ctx.fillStyle = P.textStrong;
            const nameMax = 300;
            const firstName = fitText(ctx, first.name, nameMax);
            ctx.fillText(firstName, PAD + 28, cy);
            const firstW = ctx.measureText(firstName).width;

            ctx.font = `400 23px ${FONT_STACK}`;
            ctx.fillStyle = P.textFaint;
            ctx.fillText(verb, PAD + 28 + firstW + 12, cy);
            const verbW = ctx.measureText(verb).width;

            const secondX = PAD + 28 + firstW + 12 + verbW + 12;
            dot(ctx, secondX + 8, cy, 8, second.color);
            ctx.font = `600 25px ${FONT_STACK}`;
            ctx.fillStyle = P.text;
            ctx.fillText(fitText(ctx, second.name, nameMax), secondX + 28, cy);

            ctx.font = `700 25px ${FONT_STACK}`;
            ctx.fillStyle = r.decided ? P.accent : P.textFaint;
            ctx.textAlign = 'right';
            const score = m.isPoints ? `${first.scoreStr}-${second.scoreStr}` : first.scoreStr;
            ctx.fillText(`${score}${r.decided ? '' : ' ⏳'}`, IMG_W - PAD, cy);
            ctx.textAlign = 'left';

            y += RESULT_ROW_H;
        });
        y += SECTION_GAP;
    }

    // Highlight cards
    if (cards.length) {
        const gap = 20;
        const cardW = (IMG_W - PAD * 2 - gap * (cards.length - 1)) / cards.length;
        cards.forEach((c, i) => {
            const cx = PAD + i * (cardW + gap);
            roundRect(ctx, cx, y, cardW, CARDS_H, 14);
            ctx.fillStyle = P.cardBg;
            ctx.fill();
            ctx.strokeStyle = P.cardBorder;
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.font = `400 34px ${FONT_STACK}`;
            ctx.fillText(c.emoji, cx + 20, y + 36);
            ctx.font = `700 17px ${FONT_STACK}`;
            ctx.fillStyle = P.textFaint;
            ctx.fillText(c.label, cx + 66, y + 36);

            dot(ctx, cx + 28, y + 78, 7, c.color);
            ctx.font = `700 23px ${FONT_STACK}`;
            ctx.fillStyle = P.textStrong;
            ctx.fillText(fitText(ctx, c.name, cardW - 60), cx + 44, y + 78);

            ctx.font = `400 19px ${FONT_STACK}`;
            ctx.fillStyle = P.textMuted;
            ctx.fillText(fitText(ctx, c.sub, cardW - 40), cx + 20, y + 111);
        });
        y += CARDS_H + SECTION_GAP;
    }

    // Standings
    if (m.standings.length) {
        sectionTitle('Standings');
        m.standings.forEach(s => {
            const cy = y + STANDING_ROW_H / 2;
            ctx.font = `700 24px ${FONT_STACK}`;
            ctx.fillStyle = P.textFaint;
            ctx.textAlign = 'right';
            ctx.fillText(String(s.rank), PAD + 34, cy);
            ctx.textAlign = 'left';

            dot(ctx, PAD + 60, cy, 8, s.color);
            ctx.fillStyle = P.textStrong;
            ctx.fillText(fitText(ctx, s.name, IMG_W - PAD * 2 - 320), PAD + 80, cy);

            if (s.move !== 0) {
                ctx.font = `700 21px ${FONT_STACK}`;
                ctx.fillStyle = s.move > 0 ? P.positive : P.negative;
                ctx.textAlign = 'right';
                ctx.fillText(s.move > 0 ? `▲${s.move}` : `▼${-s.move}`, IMG_W - PAD - 160, cy);
                ctx.textAlign = 'left';
            }

            ctx.font = `600 24px ${FONT_STACK}`;
            ctx.fillStyle = P.text;
            ctx.textAlign = 'right';
            ctx.fillText(s.detail ? `${s.record}  ${s.detail}` : s.record, IMG_W - PAD, cy);
            ctx.textAlign = 'left';

            y += STANDING_ROW_H;
        });
        y += SECTION_GAP;
    }

    // Footer branding
    drawBrandFooter(ctx, height);

    return canvas;
}

// ==== Team matchup recap (one team's head-to-head that week) ====

function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
}

// SWID comparison, tolerant of the brace-wrapped/case forms ESPN uses in different places.
function normalizeSwid(s) {
    return String(s || '').toUpperCase().replace(/[{}]/g, '');
}

/**
 * The signed-in user's own team id, matched by SWID against each team's owners. Used only to
 * pre-select a default in the recap's team picker.
 * @returns {number|string|null} Null when the SWID is unknown or owns no team in this league.
 */
export function detectMyTeamId() {
    const me = normalizeSwid(AppState.userSwid);
    if (!me) return null;
    const teams = AppState.apiData?.teams || [];
    const match = teams.find(t => [t.primaryOwner, ...(t.owners || [])].map(normalizeSwid).includes(me));
    return match ? match.id : null;
}

function fmtCatValue(v) {
    if (v === undefined || v === null) return '-';
    const n = Number(v);
    if (!Number.isFinite(n)) return '-';
    return (n % 1 !== 0) ? n.toFixed(3) : String(n);
}

/**
 * One team's head-to-head result for a matchup week: the two teams, the final score and, in a
 * category league, who won each category. Categories come from the per-week totals the Team
 * Metrics graphs use, compared with the league's own inverse-stat directions.
 * @param {number} week A matchup period id.
 * @param {number|string} teamId
 * @returns {TeamRecapModel|null} A stub with noGame set when the team had no matchup that week, null when no league is loaded.
 */
export function buildTeamMatchupRecapModel(week, teamId) {
    const data = AppState.apiData;
    if (!data || !week || teamId == null) return null;
    // The recap describes the loaded matchup, so its stat maps come from the loaded league's sport and not from the form, which may have changed since.
    const sport = AppState.loadedSport;
    const isPoints = AppState.isPointsLeague;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const inverseSet = leagueInverseIds(sport);
    const leagueName = data.settings?.name || 'My League';
    const seasonId = data.seasonId || '';

    const teamById = {};
    AppState.teamStats.forEach(t => { teamById[t.id] = t; });
    const meTeam = teamById[teamId];
    const meName = meTeam ? meTeam.name : `Team ${teamId}`;

    const game = (data.schedule || []).find(g => g.matchupPeriodId === week && g.home && g.away &&
        (g.home.teamId === teamId || g.away.teamId === teamId));

    if (!game) {
        return {
            kind: 'team', noGame: true, week, leagueName, seasonId, teamName: meName, inProgress: false,
            shareTitle: `${meName}: Matchup ${week}`, filenameBase: `${slugify(meName)}-matchup-${week}`
        };
    }

    const meKey = game.home.teamId === teamId ? 'home' : 'away';
    const oppKey = meKey === 'home' ? 'away' : 'home';
    const sideInfo = (key) => {
        const id = game[key].teamId;
        const team = teamById[id];
        let value, scoreStr;
        if (isPoints) {
            value = matchupPoints(game[key]);
            scoreStr = value.toFixed(1);
        } else {
            const tally = matchupTally(game[key]);
            const wins = tally?.wins || 0;
            const losses = tally?.losses || 0;
            const ties = tally?.ties || 0;
            value = wins + ties * 0.5;
            scoreStr = `${wins}-${losses}-${ties}`;
        }
        return {
            id, name: team ? team.name : `Team ${id}`, abbrev: team ? team.abbrev : `T${id}`,
            color: AppState.teamColorMap[id] || '#888', value, scoreStr,
            weeklyCats: team ? (team.weeklyCats[week] || {}) : {}
        };
    };
    const me = sideInfo(meKey);
    const opp = sideInfo(oppKey);

    const decided = !!game.winner && game.winner !== 'UNDECIDED';
    const tie = game.winner === 'TIE';
    const result = tie ? 'T' : (!decided ? '?' : (game.winner === meKey.toUpperCase() ? 'W' : 'L'));

    const categories = [];
    let catsWon = 0, catsLost = 0, catsTied = 0;
    if (!isPoints) {
        // Role-grouped like every other surface; the league's own scoring order interleaves the roles.
        orderStatIdsByRole(sport, Array.from(AppState.scoredStatIds)).forEach(id => {
            const myVal = me.weeklyCats[id];
            const oppVal = opp.weeklyCats[id];
            if (myVal === undefined || oppVal === undefined) return;
            const inverse = inverseSet.has(id);
            let winnerSide;
            if (myVal === oppVal) { winnerSide = 'tie'; catsTied++; }
            else if (inverse ? myVal < oppVal : myVal > oppVal) { winnerSide = 'me'; catsWon++; }
            else { winnerSide = 'opp'; catsLost++; }
            categories.push({ id, name: statMap[id] || `Stat ${id}`, myVal, oppVal, inverse, winnerSide });
        });
        // Flag where the second role group starts so the image and the text can both mark it. Only when BOTH groups actually produced categories, so a single-role league carries no flag and renders exactly as it did before. categories is already role-ordered, so the first secondary-group entry sits at exactly primary.length.
        const { primary, secondary } = splitStatIdsByRole(sport, categories.map(c => c.id));
        if (primary.length && secondary.length) categories[primary.length].groupBreakBefore = true;
    }

    return {
        kind: 'team', leagueName, seasonId, week, isPoints,
        inProgress: !decided,
        me, opp, decided, tie, result, categories, catsWon, catsLost, catsTied,
        shareTitle: `${me.name} vs ${opp.name}: Matchup ${week}`,
        filenameBase: `${slugify(me.name)}-vs-${slugify(opp.name)}-matchup-${week}`
    };
}

const RESULT_WORD = { W: 'WON', L: 'LOST', T: 'TIED', '?': 'IN PROGRESS' };

/**
 * One team's head-to-head as plain text for a chat, with a line per category in a category league.
 * @param {TeamRecapModel} m A model from buildTeamMatchupRecapModel.
 * @returns {string}
 */
export function buildTeamMatchupText(m) {
    if (m.noGame) return `${m.teamName} had no matchup in Matchup ${m.week}.`;
    const verb = m.result === 'W' ? 'defeated' : m.result === 'L' ? 'lost to' : (m.result === 'T' ? 'tied' : 'vs');
    const lines = [];
    lines.push(`🥊 ${m.leagueName}: Matchup ${m.week}${m.inProgress ? ' (in progress)' : ''}`);
    lines.push('');
    if (m.isPoints) {
        lines.push(`${m.me.name} ${verb} ${m.opp.name}`);
        lines.push(`${m.me.scoreStr}-${m.opp.scoreStr}`);
    } else {
        lines.push(`${m.me.name} ${verb} ${m.opp.name}, ${m.me.scoreStr}`);
        if (m.categories.length) {
            lines.push('');
            m.categories.forEach(c => {
                // Blank line between the role groups (the text form's divider). Absent for a single-role league, which keeps its output byte-identical to before.
                if (c.groupBreakBefore) lines.push('');
                const mark = c.winnerSide === 'me' ? '✅' : c.winnerSide === 'opp' ? '❌' : '➖';
                lines.push(`${mark} ${c.name}: ${fmtCatValue(c.myVal)} vs ${fmtCatValue(c.oppVal)}`);
            });
        }
    }
    lines.push('', `📈 Made with ${BRAND_NAME}`);
    return lines.join('\n');
}

const SCOREBOARD_H = 172;
const CAT_HEADER_H = 44;
const CAT_ROW_H = 46;
// Room for the thin rule between the two role groups: a grouping hint, not a section break.
const CAT_GROUP_GAP = 14;

function renderTeamMatchupImage(m) {
    const hasCats = !m.noGame && m.categories && m.categories.length > 0;
    // Zero for a single-role league, so its image height is unchanged.
    const groupGap = hasCats && m.categories.some(c => c.groupBreakBefore) ? CAT_GROUP_GAP : 0;
    const bodyH = m.noGame
        ? 120
        : SCOREBOARD_H + SECTION_GAP + (hasCats ? CAT_HEADER_H + m.categories.length * CAT_ROW_H + groupGap + SECTION_GAP : 0);
    const height = HEADER_H + SECTION_GAP + bodyH + FOOTER_H;

    const canvas = document.createElement('canvas');
    canvas.width = IMG_W;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'middle';

    ctx.fillStyle = P.white;
    ctx.fillRect(0, 0, IMG_W, height);

    // Header band
    ctx.fillStyle = P.brandTile;
    ctx.fillRect(0, 0, IMG_W, HEADER_H);
    drawBrandMark(ctx, PAD, 44, 80);
    ctx.fillStyle = P.white;
    ctx.font = `700 44px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, m.leagueName, IMG_W - PAD * 2 - 110), PAD + 108, 74);
    ctx.fillStyle = P.headerSub;
    ctx.font = `600 26px ${FONT_STACK}`;
    ctx.fillText(`Matchup ${m.week} Head-to-Head${m.seasonId ? ` • ${m.seasonId}` : ''}${m.inProgress ? '  (in progress)' : ''}`, PAD + 108, 118);

    let y = HEADER_H + SECTION_GAP;

    if (m.noGame) {
        ctx.fillStyle = P.textMuted;
        ctx.font = `600 28px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${m.teamName} had no matchup in Matchup ${m.week}.`, IMG_W / 2, y + 50);
        ctx.textAlign = 'left';
    } else {
        // Scoreboard panel
        roundRect(ctx, PAD, y, IMG_W - PAD * 2, SCOREBOARD_H, 16);
        ctx.fillStyle = P.cardBg;
        ctx.fill();
        ctx.strokeStyle = P.cardBorder;
        ctx.lineWidth = 2;
        ctx.stroke();

        const nameY = y + 52;
        const half = IMG_W / 2;
        // My team (left)
        dot(ctx, PAD + 34, nameY, 10, m.me.color);
        ctx.font = `700 32px ${FONT_STACK}`;
        ctx.fillStyle = P.textStrong;
        ctx.fillText(fitText(ctx, m.me.name, half - PAD - 120), PAD + 56, nameY);
        // Opponent (right)
        ctx.textAlign = 'right';
        ctx.fillText(fitText(ctx, m.opp.name, half - PAD - 120), IMG_W - PAD - 34, nameY);
        ctx.textAlign = 'left';
        dot(ctx, IMG_W - PAD - 18, nameY, 10, m.opp.color);

        // Center score
        ctx.textAlign = 'center';
        ctx.font = `800 60px ${FONT_STACK}`;
        ctx.fillStyle = P.navy;
        const centerScore = m.isPoints ? `${m.me.scoreStr}-${m.opp.scoreStr}` : `${m.me.scoreStr}`;
        ctx.fillText(centerScore, half, y + 108);

        // Result word
        const resultColor = m.result === 'W' ? P.positive : m.result === 'L' ? P.negative : P.textFaint;
        ctx.font = `700 24px ${FONT_STACK}`;
        ctx.fillStyle = resultColor;
        ctx.fillText(RESULT_WORD[m.result] || '', half, y + 150);
        ctx.textAlign = 'left';

        y += SCOREBOARD_H + SECTION_GAP;

        if (hasCats) {
            // Column header. Team names label the left/right value columns
            ctx.font = `700 18px ${FONT_STACK}`;
            ctx.fillStyle = P.textFaint;
            ctx.fillText(fitText(ctx, m.me.abbrev || m.me.name, 220), PAD + 8, y + CAT_HEADER_H / 2);
            ctx.textAlign = 'center';
            ctx.fillStyle = P.sectionLabel;
            ctx.fillText('CATEGORY', IMG_W / 2, y + CAT_HEADER_H / 2);
            ctx.textAlign = 'right';
            ctx.fillStyle = P.textFaint;
            ctx.fillText(fitText(ctx, m.opp.abbrev || m.opp.name, 220), IMG_W - PAD - 8, y + CAT_HEADER_H / 2);
            ctx.textAlign = 'left';
            ctx.strokeStyle = P.divider;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(PAD, y + CAT_HEADER_H);
            ctx.lineTo(IMG_W - PAD, y + CAT_HEADER_H);
            ctx.stroke();
            y += CAT_HEADER_H;

            m.categories.forEach((c, i) => {
                if (c.groupBreakBefore) {
                    // Subtle 1px rule, inset from the zebra rows and thinner than the 2px header/footer rules, so it reads as a grouping hint rather than a new section. Skipped entirely for a single-role league (no flag set).
                    ctx.strokeStyle = P.divider;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(PAD + 8, y + CAT_GROUP_GAP / 2);
                    ctx.lineTo(IMG_W - PAD - 8, y + CAT_GROUP_GAP / 2);
                    ctx.stroke();
                    y += CAT_GROUP_GAP;
                }
                const cy = y + CAT_ROW_H / 2;
                if (i % 2 === 1) {
                    ctx.fillStyle = P.zebra;
                    ctx.fillRect(PAD, y, IMG_W - PAD * 2, CAT_ROW_H);
                }
                // Category name (center) with a ↓ hint for lower-is-better
                ctx.textAlign = 'center';
                ctx.font = `600 21px ${FONT_STACK}`;
                ctx.fillStyle = P.catName;
                ctx.fillText(c.name + (c.inverse ? ' ↓' : ''), IMG_W / 2, cy);
                // My value on the left, green and bold when I won the category.
                const meWon = c.winnerSide === 'me';
                ctx.textAlign = 'left';
                ctx.font = `${meWon ? 700 : 400} 23px ${FONT_STACK}`;
                ctx.fillStyle = meWon ? P.positive : P.textFaint2;
                ctx.fillText(`${meWon ? '✓ ' : ''}${fmtCatValue(c.myVal)}`, PAD + 8, cy);
                // Opp value (right)
                const oppWon = c.winnerSide === 'opp';
                ctx.textAlign = 'right';
                ctx.font = `${oppWon ? 700 : 400} 23px ${FONT_STACK}`;
                ctx.fillStyle = oppWon ? P.positive : P.textFaint2;
                ctx.fillText(`${fmtCatValue(c.oppVal)}${oppWon ? ' ✓' : ''}`, IMG_W - PAD - 8, cy);
                ctx.textAlign = 'left';
                y += CAT_ROW_H;
            });
            y += SECTION_GAP;
        }
    }

    // Footer branding
    drawBrandFooter(ctx, height);

    return canvas;
}

// ==== Share / copy / download actions ====

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('image encoding failed')), 'image/png');
    });
}

// Feature-detected once per open. Sharing files is what reaches phone chat apps through the OS share sheet. Desktop Firefox lacks it, so the modal leads with copy and download there.
function shareFilesSupported() {
    if (typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
    try {
        return navigator.canShare({ files: [new File([''], 'recap.png', { type: 'image/png' })] });
    } catch {
        return false;
    }
}

function clipboardImageSupported() {
    return typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
}

// ==== Modal UI ====

function ensureRecapModal() {
    let overlay = document.getElementById('recap-modal-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'recap-modal-overlay';
    overlay.className = 'rank-modal-overlay';
    overlay.innerHTML = `
        <div class="rank-modal-content recap-modal-content">
            <button type="button" class="rank-modal-close" id="recap-modal-close-btn">&times;</button>
            <h3>Weekly Recap</h3>
            <div class="rank-modal-subtitle recap-week-row">
                <label for="recap-scope-select">View:</label>
                <select id="recap-scope-select"></select>
                <label for="recap-week-select">Matchup:</label>
                <select id="recap-week-select"></select>
                <span id="recap-inprogress-note"></span>
            </div>
            <div id="recap-preview" class="recap-preview"></div>
            <div class="export-actions">
                <button type="button" class="export-action-btn export-action-primary" id="recap-share-btn">📤 Share...</button>
                <button type="button" class="export-action-btn" id="recap-copy-image-btn">🖼 Copy Image</button>
                <button type="button" class="export-action-btn" id="recap-copy-text-btn">📋 Copy Text</button>
                <button type="button" class="export-action-btn" id="recap-download-btn">⬇ Download PNG</button>
            </div>
            <div id="recap-status" class="export-status"></div>
            <details class="recap-text-details">
                <summary>Text version (for chats without image support)</summary>
                <textarea id="recap-text-block" class="recap-text-block" readonly rows="10"></textarea>
            </details>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
    });
    overlay.querySelector('#recap-modal-close-btn').addEventListener('click', () => overlay.classList.remove('open'));
    return overlay;
}

function setRecapStatus(text, isError = false) {
    const el = document.getElementById('recap-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'export-status' + (isError ? ' export-status-error' : text ? ' export-status-ok' : '');
}

/**
 * Opens the weekly recap modal: builds its scope and matchup pickers, renders the image and text
 * preview and wires share, copy and download. Does nothing before data loads or in a roto league,
 * which has no per-matchup sides.
 * @returns {void}
 */
export function openRecapModal() {
    if (!AppState.apiData || !AppState.teamStats.length) return;
    // Defence in depth behind the disabled button (see processCoreData). A recap is built from one matchup's two sides, which a roto league never has.
    if (AppState.isRotoLeague) return;
    const overlay = ensureRecapModal();

    const scopeSelect = overlay.querySelector('#recap-scope-select');
    const weekSelect = overlay.querySelector('#recap-week-select');
    const maxWeek = AppState.maxCompletedWeek;
    const defWeek = defaultRecapWeek();
    weekSelect.innerHTML = Array.from({ length: maxWeek }, (_, i) => i + 1)
        .map(w => `<option value="${w}"${w === defWeek ? ' selected' : ''}>Matchup ${w}</option>`)
        .join('');

    // Scope picker: whole-league recap (default) plus one option per team for that team's own head-to-head. The user's own team (matched by SWID) is marked and listed first among the teams so "my matchup" is a single click, without displacing the league recap default.
    const myTeamId = detectMyTeamId();
    const teamsForPicker = [...AppState.teamStats].sort((a, b) =>
        (a.id === myTeamId ? -1 : 0) - (b.id === myTeamId ? -1 : 0) || a.name.localeCompare(b.name));
    scopeSelect.innerHTML = '<option value="league">Whole League</option>' +
        teamsForPicker.map(t => `<option value="team:${t.id}">${escapeHtml(t.name)}${t.id === myTeamId ? ' (My Team)' : ''}</option>`).join('');

    let model = null;
    let canvas = null;

    const rebuild = () => {
        const week = parseInt(weekSelect.value, 10);
        const scope = scopeSelect.value;
        model = scope.startsWith('team:')
            ? buildTeamMatchupRecapModel(week, parseInt(scope.slice(5), 10))
            : buildRecapModel(week);
        canvas = renderRecapImageOf(model);
        canvas.className = 'recap-canvas';
        const preview = overlay.querySelector('#recap-preview');
        preview.innerHTML = '';
        preview.appendChild(canvas);
        overlay.querySelector('#recap-text-block').value = recapTextOf(model);
        overlay.querySelector('#recap-inprogress-note').textContent = model.inProgress ? '⏳ still in progress' : '';
        setRecapStatus('');
    };
    scopeSelect.onchange = rebuild;
    weekSelect.onchange = rebuild;
    rebuild();

    const shareBtn = overlay.querySelector('#recap-share-btn');
    const copyImageBtn = overlay.querySelector('#recap-copy-image-btn');
    // Where file sharing is unavailable the share button is hidden and copy and download remain. Image copy is hidden the same way.
    shareBtn.style.display = shareFilesSupported() ? '' : 'none';
    copyImageBtn.style.display = clipboardImageSupported() ? '' : 'none';

    const escapeFilename = (s) => (s || 'recap').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

    shareBtn.onclick = async () => {
        try {
            const blob = await canvasToBlob(canvas);
            const file = new File([blob], `${escapeFilename(model.filenameBase)}.png`, { type: 'image/png' });
            await navigator.share({ files: [file], title: model.shareTitle, text: recapTextOf(model) });
            setRecapStatus('Shared ✓');
        } catch (err) {
            // Closing the share sheet without a target rejects with AbortError, which is a normal action and not a failure.
            if (err.name !== 'AbortError') setRecapStatus(`Couldn't share: ${err.message}`, true);
        }
    };
    copyImageBtn.onclick = async () => {
        try {
            const blob = await canvasToBlob(canvas);
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            setRecapStatus('Image copied. Paste it into your league chat ✓');
        } catch (err) {
            setRecapStatus(`Couldn't copy image: ${err.message}`, true);
        }
    };
    overlay.querySelector('#recap-copy-text-btn').onclick = async () => {
        try {
            await navigator.clipboard.writeText(recapTextOf(model));
            setRecapStatus('Text copied ✓');
        } catch (err) {
            setRecapStatus(`Couldn't copy: ${err.message}`, true);
        }
    };
    overlay.querySelector('#recap-download-btn').onclick = async () => {
        try {
            const blob = await canvasToBlob(canvas);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${escapeFilename(model.filenameBase)}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setRecapStatus('Downloaded ✓');
        } catch (err) {
            setRecapStatus(`Couldn't save: ${err.message}`, true);
        }
    };

    overlay.classList.add('open');
}
