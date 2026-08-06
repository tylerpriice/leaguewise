// Shareable weekly "league recap" - the Phase 1 viral-loop item from ROADMAP.md: a lightly branded image + text block summarizing one matchup week (results, blowout/nail-biter, team of the week, standings with movement), built to be posted into a league group chat where every reader is a prospect. Sharing: the Web Share API (navigator.share with files) hands the image+text straight to the OS share sheet - on phones/tablets and share-capable desktops that reaches Signal, Messenger, WhatsApp, etc. directly. Browsers without it (notably desktop Firefox) get first-class fallbacks instead: copy the text, copy the image, or download the PNG and drop it into any chat app. The model/text builders are pure-ish (AppState in, plain data out) and unit-tested in tests/features.test.html; the canvas renderer and modal own the presentation.

import { AppState, ESPN_STAT_MAPS, INVERSE_STATS } from './state.js';
import { escapeHtml, orderStatIdsByRole, splitStatIdsByRole } from './utils.js';

const BRAND_NAME = 'Leaguewise';
const BRAND_TAGLINE = 'Free fantasy league analytics';
const FONT_STACK = '"Segoe UI", Roboto, Arial, sans-serif';

// The canvas recap image has its own fixed palette, on purpose. It is exported and posted into chats, not viewed inside the app, so it stays light + branded regardless of the app's light/dark theme (the DOM uses CSS tokens instead - see dashboard.css and ROADMAP theming). This is the "one source of truth" for the image's colors. `brand` is the orange used for the logo mark and wordmark; `accent` blue stays on scores/data; the header is navy.
const P = {
    white: '#ffffff',
    navy: '#1b2b4b',
    navyTo: '#2f4f8f',
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
    brand: '#e8792e',
    teamFallback: '#888888'
};

// ==== Recap model ====

// The latest week where every scheduled game has a decided winner - the natural default for a recap ("last week's results"). Falls back to the latest week with ANY activity (an in-progress current matchup, clearly labeled) when no week has fully finished yet.
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

// Cumulative standings through `thruWeek`, sorted like the Rankings bars (match wins, cat wins as tiebreaker) - used twice per recap (this week and the week before) to derive movement. weeklyMatchWins holds the 1/0.5/0 RESULT in a category league but the raw POINTS SCORED in a points one, whose result lives in weeklyMatchResult. This read the field the same way for both, so a points league counted a win only when a team scored exactly 1.00 in a week: every team read as winless, the standings were ordered by points-for rather than by matchups won, and the movement arrows were derived from that order. A points league is decided by matchups won, with points as the tiebreak - the owner's own league sends the most matchup wins to the playoffs - so it now sorts and reads that way, keeping the points total beside the record rather than in place of it.
function standingsThrough(thruWeek, isPoints) {
    return AppState.teamStats.map(t => {
        let matchWins = 0, points = 0, cWins = 0, w = 0, l = 0, ties = 0;
        for (let wk = 1; wk <= thruWeek; wk++) {
            const val = t.weeklyMatchWins[wk];
            if (val === undefined) continue;
            if (isPoints) points += val;
            // A playoff bye is not a game and belongs in no record.
            if (t.weeklyBye?.[wk]) continue;
            const result = isPoints ? (t.weeklyMatchResult[wk] || 0) : val;
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
                value = g[key].totalPoints || 0;
                scoreStr = value.toFixed(1);
            } else {
                const wins = g[key].cumulativeScore?.wins || 0;
                const losses = g[key].cumulativeScore?.losses || 0;
                const ties = g[key].cumulativeScore?.ties || 0;
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

    const decidedGames = results.filter(r => r.decided && !r.tie);
    const blowout = decidedGames.length ? decidedGames.reduce((a, b) => (b.margin > a.margin ? b : a)) : null;
    // Only worth calling out when it's a DIFFERENT game than the blowout - a one-game week has no meaningful "closest" distinct from its "biggest".
    let nailbiter = decidedGames.length > 1 ? decidedGames.reduce((a, b) => (b.margin < a.margin ? b : a)) : null;
    if (nailbiter === blowout) nailbiter = null;

    // Team of the week: best single-week production - category wins for category leagues (a week's cat wins can exceed the H2H result's 0/0.5/1), raw points for points leagues.
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
        results, blowout, nailbiter, teamOfWeek, standings,
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

// The brand mark: a rising "W" sparkline (same mark as the app's top-bar lockup - see dashboard.html) in a white rounded tile so it reads like an app icon against the navy header. Drawn, not an image asset, so the extension ships no extra files and the canvas needs no async loads. Geometry mirrors the SVG's 24-unit grid.
function drawBrandMark(ctx, x, y, size) {
    roundRect(ctx, x, y, size, size, size * 0.22);
    ctx.fillStyle = P.white;
    ctx.fill();

    const u = size / 24; // same coordinate grid as the SVG mark
    const pts = [[3, 8], [8, 17.5], [12, 10.5], [16, 17.5], [21, 6]];
    ctx.beginPath();
    pts.forEach(([px, py], i) => {
        const cx = x + px * u, cy = y + py * u;
        i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    });
    ctx.strokeStyle = P.brand;
    ctx.lineWidth = 2.8 * u;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x + 21 * u, y + 6 * u, 2.4 * u, 0, Math.PI * 2);
    ctx.fillStyle = P.navy;
    ctx.fill();
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

export function renderRecapImage(m) {
    const cards = [
        m.blowout && { emoji: '💥', label: 'BLOWOUT', name: m.blowout.winner.name, sub: `over ${m.blowout.loser.name} (${m.blowout.winner.scoreStr})`, color: m.blowout.winner.color },
        m.nailbiter && { emoji: '😬', label: 'NAIL-BITER', name: m.nailbiter.winner.name, sub: `edged ${m.nailbiter.loser.name} (${m.nailbiter.winner.scoreStr})`, color: m.nailbiter.winner.color },
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
    const grad = ctx.createLinearGradient(0, 0, IMG_W, HEADER_H);
    grad.addColorStop(0, P.navy);
    grad.addColorStop(1, P.navyTo);
    ctx.fillStyle = grad;
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
    ctx.strokeStyle = P.divider;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height - FOOTER_H);
    ctx.lineTo(IMG_W, height - FOOTER_H);
    ctx.stroke();
    const fy = height - FOOTER_H / 2;
    drawBrandMark(ctx, PAD, fy - 22, 44);
    ctx.font = `700 23px ${FONT_STACK}`;
    ctx.fillStyle = P.brand;
    ctx.fillText(BRAND_NAME, PAD + 58, fy - 10);
    ctx.font = `400 18px ${FONT_STACK}`;
    ctx.fillStyle = P.textFaint;
    ctx.fillText(BRAND_TAGLINE, PAD + 58, fy + 18);

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

// The logged-in user's own team, matched by SWID against each team's owners - null when the SWID is unknown (dev preview, missing cookie) or doesn't own a team in this league. Only used to pre-select a friendly default in the recap's team picker; the user can pick any team.
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

// One team's head-to-head result for a given matchup week: the two teams, the final category (or points) score, and - for category leagues - a category-by-category breakdown of who won each. Categories come from the same per-week per-category totals the Team Metrics graphs use (weeklyCats), compared with the league's own inverse-stat directions. Returns a { noGame:true } stub when the team had no matchup that week (a bye).
export function buildTeamMatchupRecapModel(week, teamId) {
    const data = AppState.apiData;
    if (!data || !week || teamId == null) return null;
    // The recap describes the LOADED matchup, so its stat maps come from the loaded league's sport rather than from the form, which the user may have moved since.
    const sport = AppState.loadedSport;
    const isPoints = AppState.isPointsLeague;
    const statMap = ESPN_STAT_MAPS[sport] || {};
    const inverseSet = INVERSE_STATS[sport] || new Set();
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
            value = game[key].totalPoints || 0;
            scoreStr = value.toFixed(1);
        } else {
            const wins = game[key].cumulativeScore?.wins || 0;
            const losses = game[key].cumulativeScore?.losses || 0;
            const ties = game[key].cumulativeScore?.ties || 0;
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
        // Role-grouped like every other surface (batting/skaters, then pitching/goalies) - the league's own scoringItems order, which scoredStatIds preserves, interleaves the two.
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
// Vertical room for the thin rule between the two role groups (see groupBreakBefore). Deliberately small - it is a grouping hint, not a section break like SECTION_GAP.
const CAT_GROUP_GAP = 14;

export function renderTeamMatchupImage(m) {
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
    const grad = ctx.createLinearGradient(0, 0, IMG_W, HEADER_H);
    grad.addColorStop(0, P.navy);
    grad.addColorStop(1, P.navyTo);
    ctx.fillStyle = grad;
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
                // My value (left) - green + bold if I won it
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
    ctx.strokeStyle = P.divider;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height - FOOTER_H);
    ctx.lineTo(IMG_W, height - FOOTER_H);
    ctx.stroke();
    const fy = height - FOOTER_H / 2;
    drawBrandMark(ctx, PAD, fy - 22, 44);
    ctx.font = `700 23px ${FONT_STACK}`;
    ctx.fillStyle = P.brand;
    ctx.fillText(BRAND_NAME, PAD + 58, fy - 10);
    ctx.font = `400 18px ${FONT_STACK}`;
    ctx.fillStyle = P.textFaint;
    ctx.fillText(BRAND_TAGLINE, PAD + 58, fy + 18);

    return canvas;
}

// ==== Share / copy / download actions ====

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('image encoding failed')), 'image/png');
    });
}

// Feature-detected once per open. navigator.share with FILES is what actually reaches phone/chat apps (Signal, Messenger, WhatsApp...) via the OS share sheet. Desktop Firefox doesn't implement it - the modal shows copy/download as the primary path there.
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
    // navigator.share with files reaches phone/chat apps (Signal, Messenger, WhatsApp...) via the OS share sheet; where it isn't available, the button is hidden and copy/download stay as the path. Same for image-to-clipboard.
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
            // Closing the OS share sheet without picking a target rejects with AbortError - that's a normal user action, not a failure worth alarming anyone about.
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
