/**
 * Renders one Player Metrics leaderboard row and its header: a fixed identity column, the rank as a slab figure, points per game where the league carries it, stat cells sharing the remaining width evenly and a rostered-percent arc dial.
 *
 * Pure. No imports, no application state, no DOM, no fetches. Every number arrives already computed; this module only turns the finished row model into markup. The escaper, avatar, injury badge and sort arrow builders arrive through the options, because the modules that own them import the application state, and local fallbacks exist for a caller that supplies none.
 *
 * Contract: tests/fixtures/leaderboard-row.md
 * @module leaderboard-row
 */
/**
 * @typedef {Object} LeaderboardCell One stat cell of a row.
 * @property {string} label The stat's header label.
 * @property {string} value The printed value, or '-' for no figure.
 * @property {?number} pct Percentile against the pool, already inverse-aware.
 * @property {boolean} [estimated] True when the figure is an estimate.
 * @property {?number} [delta] Difference from the group's anchor, null outside a group.
 * @property {?string} [better] 'up', 'down' or 'even', the colour of the delta.
 */
/**
 * @typedef {Object} LeaderboardRowModel The finished row model.
 * @property {(string|number)} id The player id.
 * @property {string} name The player name.
 * @property {?string} proAbbrev The pro club abbreviation.
 * @property {?string} posLabel The position label.
 * @property {?string} gpLabel The games-played label.
 * @property {?string} injuryStatus The injury status handed to the badge builder.
 * @property {boolean} [isFreeAgent] True for a free agent.
 * @property {boolean} [isAnchor] True for the comparison group's anchor.
 * @property {?{name: string, logo: ?string, color: ?string}} [team] The fantasy team, null for a free agent.
 * @property {?{label: (string|number), tied: boolean, gold: boolean}} rank The overall rank, null when unranked.
 * @property {?{winsPerWeek: number, rank: {label: (string|number), tied: boolean}}} [matchupRank] Category wins a week, null when unmeasured.
 * @property {?number} [total] A points league's total.
 * @property {?number} [ptsPerGame] Points per game.
 * @property {LeaderboardCell[]} cells The stat cells, in the header's order.
 * @property {?{pct: number, change: number}} [rostered] The rostered share and its weekly change.
 * @property {?Object} [playoff] The playoff lens: byRound, trend, projected and rank.
 * @property {?Object} [window] The this-matchup games window.
 * @property {?Object} [next] The next-matchup games window.
 * @property {?Object} [rest] The rest-of-season games window.
 * @property {?{nights: Array, count: number}} [openSeats] Nights with an open seat.
 * @property {?{opponent: string, away: boolean, when: string}} [nextGame] The next game for the phone points form,
 *   from nextGameCell. Absent leaves the row as it was; null draws a dash.
 * @property {?{total: ?FigureDelta, ptsPerGame: ?FigureDelta, gp: ?FigureDelta, rank: ?FigureDelta}} [figDeltas] A compared row's
 *   difference from the anchor under each of the phone points form's figures. Absent draws nothing.
 */
/**
 * @typedef {Object} FigureDelta A figure's signed difference from the anchor.
 * @property {number} delta The difference, positive when this row is the better of the two.
 * @property {string} better 'up', 'down' or 'even'.
 * @property {string} text The difference as printed, without its sign.
 */
/**
 * @typedef {Object} LeaderboardPick The pick-to-compare control state.
 * @property {?string} state 'anchor', 'picked' or null for an unpicked row.
 * @property {number} [number] The pick order, never the rank.
 * @property {boolean} [capReached] True when no more players can be picked.
 */
/**
 * @typedef {Object} LeaderboardOpts Rendering options; every field is optional.
 * @property {function(*): string} [escapeHtml] HTML escaper.
 * @property {function((string|number), string): string} [avatarHtml] Avatar builder.
 * @property {function(?string): string} [logoHtml] Club logo builder.
 * @property {function(?string): string} [proTeamCrestHtml] Crest builder for a D/ST row.
 * @property {function(?string): string} [injuryBadgeHtml] Injury badge builder.
 * @property {function((string|number)): string} [sortArrowHtml] Sort arrow builder.
 * @property {boolean} [interactive] False marks the row inert; defaults to true.
 * @property {function(number): string} [formatDelta] Formats the absolute value of a delta.
 */
/**
 * Escapes the five HTML-significant characters; the fallback when the caller supplies no escaper.
 *
 * @param {*} str The value to escape, stringified first.
 * @returns {string} The escaped text.
 */
export function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// An ordinal suffix, so a percentile reads as a measured fact. This is a third small copy of the seasons band's and the draft view's, because importing either would drag in what makes them impure.
function ordinal(n) {
    const v = Math.round(n);
    const tens = v % 100;
    if (tens >= 11 && tens <= 13) return `${v}th`;
    return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// Two-letter initials, the local stand-in for images.js's initialsFor when no real avatarHtml is wired in.
function initialsLocal(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarHtmlLocal(id, name) {
    return `<span class="lb-avatar-fallback">${escapeHtmlLocal(initialsLocal(name))}</span>`;
}

// Renders nothing, the same default the real logo builder draws for an unmapped abbreviation. A missing team logo has no fallback glyph, unlike the initials tile.
function logoHtmlLocal() {
    return '';
}

// A D/ST row's stand-in for the real crest builder: initials, the same fallback shape a human row draws, so an unwired caller sees one no-image tile either way.
function proTeamCrestHtmlLocal(abbrev) {
    return `<span class="lb-avatar-fallback">${escapeHtmlLocal(abbrev || '?')}</span>`;
}

// An unwired injury badge renders nothing rather than guess at a status vocabulary this module does not own.
function injuryBadgeHtmlLocal() {
    return '';
}

function sortArrowHtmlLocal() {
    return '';
}

function resolveOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        avatarHtml: o.avatarHtml || avatarHtmlLocal,
        logoHtml: o.logoHtml || logoHtmlLocal,
        proTeamCrestHtml: o.proTeamCrestHtml || proTeamCrestHtmlLocal,
        injuryBadgeHtml: o.injuryBadgeHtml || injuryBadgeHtmlLocal,
        sortArrowHtml: o.sortArrowHtml || sortArrowHtmlLocal,
        // A preseason drill-down has no games to project a matchup or a form arrow from, so the caller can mark rows inert. The default is true, so a real season needs no change.
        interactive: o.interactive !== false,
        // There is no local fallback formatter, because the bare absolute number cellDeltaHtml falls back to is the intended behaviour for a caller that never wired the group in.
        formatDelta: o.formatDelta,
    };
}

// percentileVar's own clamp (utils.js), copied rather than imported for the same purity reason as everything else here. --pct is set as a bare number; the CSS side (dashboard.css, the shared tint rule.dominance-heatmap td.dh-cell,.stat-chip,.dr-cat,.lb-cell) does the mixing.
function clampPct(pct) {
    return Math.max(0, Math.min(100, Number(pct)));
}

// Rostered-dial ring geometry. r=15 in a 36x36 viewBox leaves room for a 3px stroke without clipping, the same box a standard SVG progress-ring trick uses.
const DIAL_R = 15;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_R;

// The dial has two tones, amber for a contested share and green everywhere else. A nearly unowned player therefore reads the same green as a near-universal one, because a three-state ramp is not in the approved design.
const ROSTERED_CONTESTED_LOW = 30;
const ROSTERED_CONTESTED_HIGH = 70;

// A move under this is not news, matching the leaderboard's under-a-point rule for the same figure, so the sub-line stays off the dial rather than print churn.
const ROSTERED_CHANGE_NEWS = 5;

function metaLineHtml(model, escape) {
    if (model.nextGame !== undefined && model.gpLabel) {
        const head = [model.proAbbrev, model.posLabel].filter(Boolean).map(escape).join(' · ');
        return `${head}<span class="lb-meta-gp"> · ${escape(model.gpLabel)}</span>`;
    }
    const parts = [model.proAbbrev, model.posLabel, model.gpLabel].filter(Boolean).map(escape);
    return parts.join(' · ');
}

// A name that does not fit the identity column wraps to a second line, the first token and then the rest as one unit so St. Brown or a hyphenated surname stays whole, and is never cut with an ellipsis. A one-token name stays on one line. The first-name span carries data-full for the caller's own fit measurement.
function nameLinesHtml(name, escape) {
    const tokens = (name || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return `<span class="lb-name"><span class="lb-name-first">${escape(name)}</span></span>`;
    const first = tokens[0];
    const last = tokens.slice(1).join(' ');
    // The literal space between the two spans is the only break the browser has, so it must stay even when the spans are not forced to blocks.
    return `<span class="lb-name">` +
        `<span class="lb-name-first" data-full="${escape(first)}">${escape(first)}</span> ` +
        `<span class="lb-name-last">${escape(last)}</span>` +
        `</span>`;
}

// A D/ST row's whole identity is its club, so it draws one large crest at the avatar's size, with no player tile behind it and no second small logo beside the name. The label is the literal the caller's own secondary-label table uses.
function isProTeamUnit(model) {
    return model.posLabel === 'D/ST';
}

// The pinned block's tag, on the anchor's name line only. isAnchor is a fact about the player's identity in the group, so it rides on the model like isFreeAgent and not as a further parameter.
function anchorTagHtml(model, o) {
    return model.isAnchor ? `<span class="lb-anchor-tag">${o.escapeHtml('Anchor')}</span>` : '';
}

// The fantasy team's mark, a small disc on the avatar's lower-right corner with its logo on the crest ground, ringed in the team colour, or the ring alone when there is no usable logo. A free agent has no team and draws nothing. The model builder already applied the host rule to the logo url.
function teamDiscHtml(team, escape) {
    if (!team) return '';
    const style = team.color ? ` style="--fteam-color:${escape(team.color)}"` : '';
    const title = team.name ? ` title="${escape(team.name)}"` : '';
    const logo = team.logo ? `<img class="avatar-img" loading="lazy" alt="" src="${escape(team.logo)}">` : '';
    return `<span class="lb-team-disc"${style}${title} data-team-logo="${team.logo ? escape(team.logo) : ''}">${logo}</span>`;
}

// The ringed position badge of the phone points form, hidden at every other width by the stylesheet.
function posBadgeHtml(model, escape) {
    if (model.nextGame === undefined) return '';
    const token = String(model.posLabel || '').split('/')[0].trim();
    return token ? `<span class="lb-posbadge">${escape(token.slice(0, 3))}</span>` : '';
}

// The next-game and games-played cells of the phone points form: the opponent over the day and time, or a dash. Present only when the model carries `nextGame`, so every other row is unchanged.
function nextGameHtml(model, o) {
    if (model.nextGame === undefined) return '';
    const gpDelta = model.figDeltas ? figDeltaHtml(model.figDeltas.gp) : '';
    const g = model.nextGame;
    const escape = o.escapeHtml;
    const games = String(model.gpLabel || '').match(/^\s*(\d+)/);
    const next = g
        ? `<div class="lb-next"><span class="lb-next-opp">${escape((g.away ? '@' : '') + g.opponent)}</span><span class="lb-next-when">${escape(g.when)}</span></div>`
        : '<div class="lb-next lb-next-none">-</div>';
    return `${next}<div class="lb-gp">${games ? games[1] : '-'}${gpDelta}</div>`;
}

// The rank as a small badge on the headshot's corner, for the phone grid, which pins the identity alone. Hidden at every other width by the stylesheet, so the desktop row is what it was.
function rankBadgeHtml(model, escape) {
    const r = model.rank;
    if (!r || r.label === null || r.label === undefined) return '';
    return `<em class="lb-rankbadge${r.gold ? ' lb-rankbadge-gold' : ''}">${r.tied ? 'T' : ''}${escape(String(r.label))}</em>`;
}

// The team's colour as the ring custom property of the headshot, only for a hex (so no string reaches the style attribute).
function ringStyleAttr(model) {
    const c = model.team && model.team.color;
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? ` style="--ring:${c}"` : '';
}

function identityHtml(model, o) {
    const escape = o.escapeHtml;
    const injuryHtml = o.injuryBadgeHtml(model.injuryStatus);
    const faHtml = model.isFreeAgent ? '<span class="lb-fa-chip">FA</span>' : '';
    if (isProTeamUnit(model)) {
        return `<div class="lb-identity">
            ${posBadgeHtml(model, escape)}<span class="lb-avatar-slot"${ringStyleAttr(model)}>${o.proTeamCrestHtml(model.proAbbrev)}${teamDiscHtml(model.team, escape)}${rankBadgeHtml(model, escape)}</span>
            <span class="lb-identity-text">
                <span class="lb-name-line">${nameLinesHtml(model.name, escape)}${anchorTagHtml(model, o)}${injuryHtml}${faHtml}</span>
                <span class="lb-meta">${metaLineHtml(model, escape)}</span>
            </span>
        </div>`;
    }
    // The club logo sits beside the name, since the abbreviation already reads as a word in the meta line and the logo says the same fact as a mark. With no club to show, the row draws as it did without one.
    const logoHtml = o.logoHtml(model.proAbbrev);
    return `<div class="lb-identity">
        ${posBadgeHtml(model, escape)}<span class="lb-avatar-slot"${ringStyleAttr(model)}>${o.avatarHtml(model.id, model.name)}${teamDiscHtml(model.team, escape)}${rankBadgeHtml(model, escape)}</span>
        <span class="lb-identity-text">
            <span class="lb-name-line">${logoHtml}${nameLinesHtml(model.name, escape)}${anchorTagHtml(model, o)}${injuryHtml}${faHtml}</span>
            <span class="lb-meta">${metaLineHtml(model, escape)}</span>
        </span>
    </div>`;
}

// The rank label is the bare number, so this function owns the T versus # choice. A null rank is a real state, since the zero-games floor unranks a large share of a pool with Minimum Games off, and it uses the same dash and hover text as the existing table.
function unrankedHtml(o) {
    return `<div class="lb-rank"><span class="lb-rank-unranked" data-tooltip="${o.escapeHtml('No games played, nothing to rank on')}">-</span></div>`;
}

function rankHtml(rank, o, delta) {
    if (!rank) return unrankedHtml(o);
    const prefix = rank.tied ? 'T' : '#';
    const goldCls = rank.gold ? ' lb-rank-gold' : '';
    return `<div class="lb-rank"><span class="lb-rank-figure${goldCls}">${prefix}${o.escapeHtml(String(rank.label))}</span>${figDeltaHtml(delta)}</div>`;
}

// A compared row's difference from the anchor under one figure of the phone points form: signed, coloured by who is ahead, or "even".
function figDeltaHtml(d) {
    if (!d || !d.better) return '';
    if (d.better === 'even') return '<small class="lb-cell-delta ev">even</small>';
    const tone = d.better === 'up' ? 'up' : 'dn';
    const sign = d.delta > 0 ? '+' : '-';
    return `<small class="lb-cell-delta ${tone}">${sign}${String(d.text)}</small>`;
}

// The Matchup column shows category wins a week the line is expected to swing against the league's measured margins. A null is a real state and draws the same dash and tooltip as the Overall rank. Whether the column exists is the caller's decision, because a whole league can be unable to support it.
function matchupRankUnrankedHtml(o) {
    return `<div class="lb-mrank"><span class="lb-mrank-unranked" data-tooltip="${o.escapeHtml('Not enough categories measured to rank this player')}">-</span></div>`;
}

function matchupRankHtml(matchupRank, o) {
    if (!matchupRank) return matchupRankUnrankedHtml(o);
    const prefix = matchupRank.rank.tied ? 'T' : '#';
    const wpw = Number(matchupRank.winsPerWeek);
    // A tiny negative figure rounds to -0.00, which reads as a formatting bug, so it is shown as 0.00, which is what it is at this precision.
    let sub = wpw.toFixed(2);
    if (sub === '-0.00') sub = '0.00';
    return `<div class="lb-mrank"><span class="lb-mrank-figure">${prefix}${o.escapeHtml(String(matchupRank.rank.label))}</span><span class="lb-mrank-sub">${o.escapeHtml(`${sub}/wk`)}</span></div>`;
}

// In a points league the total is the column's headline and takes the slab treatment, with points per game as a muted line under it. A category league has no total, so the cell is points per game alone or nothing.
function totalsCellHtml(model) {
    const hasTotal = model.total !== null && model.total !== undefined;
    const hasPtsG = model.ptsPerGame !== null && model.ptsPerGame !== undefined;
    const fd = model.figDeltas || {};
    if (!hasTotal) {
        return hasPtsG ? `<div class="lb-ptsg">${Number(model.ptsPerGame).toFixed(1)}</div>` : '';
    }
    const secondaryHtml = hasPtsG
        ? `<span class="lb-ptsg-secondary">${Number(model.ptsPerGame).toFixed(1)}${figDeltaHtml(fd.ptsPerGame)}</span>`
        : '';
    return `<div class="lb-ptsg lb-ptsg-total"><span class="lb-total-figure">${Number(model.total).toFixed(1)}${figDeltaHtml(fd.total)}</span>${secondaryHtml}</div>`;
}

// The pct arrives already inverse-aware, so it is never flipped here. The dash is the string the app uses for no figure at all on an off-role category, and such a cell gets the faint unboxed treatment.
const NO_FIGURE = '-';

// The compare group's delta line. A null delta, on the anchor or on a cell the engine could not compare, draws nothing. The better field decides the colour and never the sign, since one more caught stealing than the anchor is worse though the sign is plus.
function cellDeltaHtml(cell, o) {
    if (cell.delta === null || cell.delta === undefined || !cell.better) return '';
    const escape = o.escapeHtml;
    const tone = cell.better === 'up' ? 'up' : (cell.better === 'down' ? 'dn' : 'ev');
    if (cell.better === 'even') return `<small class="lb-cell-delta ${tone}">even</small>`;
    const sign = cell.delta > 0 ? '+' : (cell.delta < 0 ? '-' : '');
    // formatDelta is the caller's own formatter, so a rate's delta prints at the rate's precision. It receives the absolute value and this function prepends the sign, so a formatter built for a positive figure needs no sign case. With none supplied the bare absolute number is used.
    const shown = o.formatDelta ? o.formatDelta(Math.abs(cell.delta)) : String(Math.abs(cell.delta));
    return `<small class="lb-cell-delta ${tone}">${escape(`${sign}${shown}`)}</small>`;
}

function cellHtml(cell, o) {
    const escape = o.escapeHtml;
    const hasPct = cell.pct !== null && cell.pct !== undefined;
    const pct = hasPct ? clampPct(cell.pct) : null;
    const isDash = cell.value === NO_FIGURE;
    const cls = ['lb-cell'];
    if (pct === null) cls.push('lb-cell-untinted');
    if (isDash) cls.push('lb-cell-dash');
    const style = pct === null ? '' : ` style="--pct:${pct}"`;
    const tipParts = [`${cell.label}: ${cell.value}`];
    if (pct !== null) tipParts.push(`${ordinal(Math.round(pct))} percentile${cell.estimated ? ', estimated' : ''}`);
    else if (cell.estimated) tipParts.push('estimated');
    const tip = escape(tipParts.join(' · '));
    return `<div class="${cls.join(' ')}"${style} data-tooltip="${tip}">${escape(cell.value)}${cellDeltaHtml(cell, o)}</div>`;
}

// The pick control is a circle at the row's left edge, a plus when unpicked and the pick order, never the rank, once picked. A null pick draws nothing, because a column that cannot exist for anyone must not exist for one row.
function pickControlHtml(pick, o) {
    if (!pick) return '';
    const escape = o.escapeHtml;
    if (pick.state === 'anchor' || pick.state === 'picked') {
        const tip = escape(pick.state === 'anchor' ? 'Anchor of the group. Click to remove.' : 'In the group. Click to remove.');
        return `<button type="button" class="lb-pick lb-pick-on" data-tooltip="${tip}">${escape(String(pick.number))}</button>`;
    }
    // A reached cap disables the control rather than hiding it, so the column does not quietly stop existing before the row the reader clicked.
    const capped = !!pick.capReached;
    const tip = escape(capped ? 'Six players at most in a group.' : 'Add to the comparison group.');
    return `<button type="button" class="lb-pick"${capped ? ' disabled' : ''} data-tooltip="${tip}">+</button>`;
}

// The change pill reads by direction, the success token for a rise and the danger token for a fall. The dial's own tone, by how contested the share is, is untouched, so a drop on a green dial no longer prints green.
function rosteredHtml(rostered, o) {
    if (!rostered) return '';
    const pct = clampPct(rostered.pct);
    const change = Number(rostered.change) || 0;
    const contested = pct >= ROSTERED_CONTESTED_LOW && pct <= ROSTERED_CONTESTED_HIGH;
    const toneCls = contested ? 'lb-dial-amber' : 'lb-dial-green';
    const filled = (pct / 100) * DIAL_CIRCUMFERENCE;
    const sign = change >= 0 ? '+' : '';
    const tip = o.escapeHtml(`Rostered in ${Math.round(pct)}% of ESPN leagues, ${sign}${change.toFixed(1)} this week`);
    const changeLineHtml = Math.abs(change) >= ROSTERED_CHANGE_NEWS
        ? `<span class="lb-dial-change ${change >= 0 ? 'lb-change-up' : 'lb-change-down'}">${change >= 0 ? '▲' : '▼'}${Math.round(Math.abs(change))} this week</span>`
        : '';
    return `<div class="lb-rostered ${toneCls}" data-tooltip="${tip}">
        <span class="lb-dial-ring">
            <svg class="lb-dial-svg" viewBox="0 0 36 36" width="30" height="30">
                <circle class="lb-dial-track" cx="18" cy="18" r="${DIAL_R}"></circle>
                <circle class="lb-dial-fill" cx="18" cy="18" r="${DIAL_R}"
                    stroke-dasharray="${filled.toFixed(2)} ${DIAL_CIRCUMFERENCE.toFixed(2)}"></circle>
            </svg>
            <span class="lb-dial-pct">${Math.round(pct)}%</span>
        </span>
        ${changeLineHtml}
    </div>`;
}

// Oxford comma, matching the draft view's own hover text. It is a third small copy, since importing that module would pull in application state and the DOM.
function oxford(parts) {
    return parts.length > 2
        ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
        : parts.join(' and ');
}

const TREND_GLYPH = { up: '↗', down: '↘', flat: '→' };
const TREND_WORD = { up: 'rising', down: 'falling', flat: 'steady' };

// The hover gives games per round and, when round lengths differ, the days each runs, then recent form. The lengths matter because ESPN can fold the pro season's tail into the final round, where a bare count reads the opposite of the truth.
function playoffHoverText(model, o) {
    const p = model.playoff;
    if (!p.byRound.length) return '';
    const subject = model.proAbbrev || 'This club';
    const gamesParts = p.byRound.map((r, i) => {
        const n = i === 0
            ? (r.games === 0 ? 'no games' : `${r.games} game${r.games === 1 ? '' : 's'}`)
            : (r.games === 0 ? 'none' : String(r.games));
        return `${n} in ${r.matchup}`;
    });
    let text = `${subject} plays ${oxford(gamesParts)}.`;
    const days = p.byRound.map(r => r.days);
    if (days.some(d => d !== days[0])) text += ` Those rounds run ${oxford(days.map(String))} days.`;
    if (p.trend) text += ` Recent form: ${TREND_WORD[p.trend]}.`;
    return o.escapeHtml(text);
}

// The playoff-window lens is one compact column, drawn only when the caller carries a bracket. The projected total takes the slab treatment of a points league's total, and the round breakdown is counts and days only, never a percentage or a verdict.
function playoffHtml(model, o) {
    const p = model.playoff;
    if (!p) return '';
    const totalGames = p.byRound.reduce((sum, r) => sum + r.games, 0);
    const roundsFigure = `${p.byRound.map(r => r.games).join(' · ')} game${totalGames === 1 ? '' : 's'}`;
    const trendHtml = p.trend
        ? `<span class="trend-icon trend-${p.trend}">${TREND_GLYPH[p.trend]}</span>`
        : '';
    // A player with no per-game projection, such as a call-up or an unmodelled rookie, has a null projected total, which is not a data gap. The counts stay, the slab falls back to rank, and it is omitted only when neither exists, never a fabricated 0.0 or a dash that would read as no playoff games.
    const hasProjected = p.projected !== null && p.projected !== undefined;
    // The same split as the Rank column: # for a solo rank and T for a tie.
    const rankFigure = p.rank
        ? `${p.rank.tied ? 'T' : '#'}${o.escapeHtml(String(p.rank.label))}`
        : '';
    const slabFigure = hasProjected ? Number(p.projected).toFixed(1) : rankFigure;
    const figureHtml = slabFigure
        ? `<span class="lb-playoff-figure"><span class="lb-total-figure">${slabFigure}</span>${trendHtml}</span>`
        : (trendHtml ? `<span class="lb-playoff-figure">${trendHtml}</span>` : '');
    const tip = playoffHoverText(model, o);
    const tipAttr = tip ? ` data-tooltip="${tip}"` : '';
    return `<div class="lb-playoff"${tipAttr}>
        ${figureHtml}
        <span class="lb-playoff-rounds">${o.escapeHtml(roundsFigure)}</span>
    </div>`;
}

// Games left for the matchup being set against, in the playoff lens's own slot. A one-game window, most football rows, names the state (Upcoming or Played), because N of 1 left reads oddly. The rest lens prints games bare, since a window running to the cutoff is not counted down within a round.
function windowFigureHtml(win, lens, o) {
    const main = lens === 'rest'
        ? String(win.games)
        : (win.games <= 1
            ? (win.remaining > 0 ? 'Upcoming' : 'Played')
            : `${win.remaining} of ${win.games} left`);
    const suffixHtml = windowSuffixHtml(win, o);
    const startsHtml = win.starts
        ? `<span class="lb-window-secondary">${win.starts.total} start${win.starts.total === 1 ? '' : 's'} · ${win.starts.remaining} left</span>`
        : '';
    return `<span class="lb-window-figure">${o.escapeHtml(main)}</span>${suffixHtml}${startsHtml}`;
}

// Off-night and two-game-day counts are suffixes on the figure, and a zero is omitted, so null and 0 render alike. Off nights take the success tone, a quiet lineup-friendly night, and two-game days the warning tone, a day worth planning around.
function windowSuffixHtml(win, o) {
    const parts = [];
    if (win.offNight) parts.push(`<span class="lb-window-off">${o.escapeHtml(`${win.offNight} off`)}</span>`);
    if (win.twoGameDays) parts.push(`<span class="lb-window-dbl">${o.escapeHtml(`${win.twoGameDays} dbl`)}</span>`);
    if (!parts.length) return '';
    return `<span class="lb-window-suffix">${parts.join(' &middot; ')}</span>`;
}

// The hover joins the per-day counts and the games left. The period field is already a printable day label, so this only joins and counts, and the starts clause appears only for a pitcher.
function windowHoverText(win, subjectLabel, o) {
    const dayParts = (win.byPeriod || []).filter(p => p.count > 0)
        .map(p => (p.count > 1 ? `${p.count} on ${p.period}` : p.period));
    const gamesWord = win.games === 1 ? 'game' : 'games';
    let text = `${win.games} ${gamesWord} ${subjectLabel}: ${oxford(dayParts)}.`;
    text += ` ${win.remaining} left.`;
    if (win.starts) text += ` ${win.starts.total} start${win.starts.total === 1 ? '' : 's'}, ${win.starts.remaining} left.`;
    return o.escapeHtml(text);
}

const WINDOW_SUBJECT_LABEL = { window: 'this matchup', next: 'next matchup', rest: 'the rest of the season' };

// Nights with an open seat are a different shape from the games windows, so they get their own figure. The words say an open seat, never started, since nobody has set a future night's lineup.
function openSeatsHtml(openSeats, o) {
    if (!openSeats) return '';
    const word = openSeats.count === 1 ? 'night' : 'nights';
    const tip = o.escapeHtml(`${openSeats.count} ${word} with an open seat this matchup.`);
    return `<div class="lb-window" data-tooltip="${tip}"><span class="lb-window-figure">${o.escapeHtml(String(openSeats.count))}</span></div>`;
}

// The dispatcher. The playoff lens keeps its markup, though the toggle no longer offers it, and the window lenses use a sibling class so one rule can size both. Open seats read a field that is not a games window.
function timeLensHtml(model, lens, o) {
    if (lens === 'playoff') return playoffHtml(model, o);
    if (lens === 'openSeats') return openSeatsHtml(model.openSeats, o);
    const win = model[lens];
    if (!win) return '';
    const tip = windowHoverText(win, WINDOW_SUBJECT_LABEL[lens], o);
    return `<div class="lb-window" data-tooltip="${tip}">${windowFigureHtml(win, lens, o)}</div>`;
}

/**
 * Builds one leaderboard row. Every optional piece omits itself rather than render a placeholder, so a missing column leaves no dead band. The lens is a default parameter, so omitting it gives 'playoff' while an explicit null draws no lens column.
 *
 * @param {LeaderboardRowModel} model The finished row model.
 * @param {LeaderboardOpts} [opts] Rendering options.
 * @param {?string} [lens] 'playoff', 'window', 'next', 'rest' or 'openSeats'; null draws no lens column.
 * @param {boolean} [showMatchupRank] True when the caller's league supports the Matchup column.
 * @param {?LeaderboardPick} [pick] The pick control state; null draws no control.
 * @returns {string} The row markup.
 */
export function buildLeaderboardRowHtml(model, opts, lens = 'playoff', showMatchupRank = false, pick = null) {
    const o = resolveOpts(opts);
    const cellsHtml = (model.cells || []).map(c => cellHtml(c, o)).join('');
    // The inert class is only a marker for the caller's CSS. This module attaches no behaviour, so the caller decides whether to attach a click handler.
    const inertCls = o.interactive ? '' : ' lb-row-inert';
    const anchorCls = pick && pick.state === 'anchor' ? ' lb-row-anchor' : '';
    return `<div class="lb-row${inertCls}${anchorCls}" data-player-id="${o.escapeHtml(String(model.id))}">
        ${pickControlHtml(pick, o)}
        ${identityHtml(model, o)}
        ${rankHtml(model.rank, o, model.figDeltas ? model.figDeltas.rank : null)}
        ${showMatchupRank ? matchupRankHtml(model.matchupRank, o) : ''}
        ${totalsCellHtml(model)}
        ${nextGameHtml(model, o)}
        ${lens ? timeLensHtml(model, lens, o) : ''}
        <div class="lb-cells">${cellsHtml}</div>
        ${rosteredHtml(model.rostered, o)}
    </div>`;
}

// Default header labels for each time lens.
const TIME_LENS_DEFAULT_LABEL = { playoff: 'Playoff', window: 'This Matchup', next: 'Next Matchup', rest: 'Rest of Season', openSeats: 'Empty Nights' };

/**
 * Builds the header row, sortable on the same keys the row model implies (name, rank, ptsPerGame, each cell id, rostered), so an existing sort handler needs no new cases.
 *
 * @param {Object} [columns] Header options.
 * @param {string} [columns.identityLabel] Identity header text; defaults to 'Player'.
 * @param {string} [columns.rankLabel] Rank header text; defaults to 'Rank'.
 * @param {string} [columns.ptsPerGameLabel] Points-per-game header text; defaults to 'PTS/G'.
 * @param {string} [columns.rosteredLabel] Rostered header text; defaults to 'Rostered'.
 * @param {string} [columns.playoffLabel] Legacy label for the time-lens column.
 * @param {boolean} [columns.showPtsPerGame] Draws the points-per-game header; default false.
 * @param {boolean} [columns.showRostered] Draws the rostered header; default true.
 * @param {boolean} [columns.showPlayoff] Same as timeLens 'playoff'; default false.
 * @param {?string} [columns.timeLens] Which lens the shared column header names; overrides showPlayoff.
 * @param {string} [columns.timeLensLabel] Overrides the per-lens default label.
 * @param {boolean} [columns.showMatchupRank] Draws the Matchup header; default false.
 * @param {string} [columns.matchupRankLabel] Matchup header text; defaults to 'Matchup'.
 * @param {boolean} [columns.showPick] Draws an empty header cell over the pick column.
 * @param {boolean} [columns.showNextGame] Draws the phone points form's header labels (hidden by the stylesheet above 700px).
 * @param {Array<{id: (string|number), label: string}>} [columns.cells] The category set and order the rows carry.
 * @param {LeaderboardOpts} [opts] Rendering options.
 * @returns {string} The header row markup.
 */
export function buildLeaderboardHeaderHtml(columns, opts) {
    const o = resolveOpts(opts);
    const cols = columns || {};
    const escape = o.escapeHtml;
    const arrow = o.sortArrowHtml;
    const cells = cols.cells || [];

    const ptsGHtml = cols.showPtsPerGame
        ? `<div class="lb-head-ptsg sortable" data-sort="ptsPerGame">${escape(cols.ptsPerGameLabel || 'PTS/G')}${arrow('ptsPerGame')}</div>`
        : '';
    const timeLens = cols.timeLens || (cols.showPlayoff ? 'playoff' : null);
    const timeLensCls = timeLens === 'playoff' ? 'lb-head-playoff' : 'lb-head-window';
    const playoffHeadHtml = timeLens
        ? `<div class="${timeLensCls} sortable" data-sort="${timeLens}">${escape(cols.timeLensLabel || cols.playoffLabel || TIME_LENS_DEFAULT_LABEL[timeLens])}${arrow(timeLens)}</div>`
        : '';
    const cellsHtml = cells.map(c =>
        `<div class="lb-head-cell sortable" data-sort="${escape(String(c.id))}">${escape(c.label)}${arrow(c.id)}</div>`
    ).join('');
    const rosteredColHtml = cols.showRostered === false ? '' :
        `<div class="lb-head-rostered sortable" data-sort="rostered">${escape(cols.rosteredLabel || 'Rostered')}${arrow('rostered')}</div>`;

    // The header's own hover is one line and separate from the click-to-open explainer, so a reader who never clicks still learns the pool the rank is scoped to.
    const rankTip = escape('Ranks against the whole group. Choosing a position ranks against that position instead.');
    // The caller passes the Overall label itself when the Matchup column exists, because this module does not guess a rename from a sibling flag.
    const matchupRankHeadHtml = cols.showMatchupRank
        ? `<div class="lb-head-mrank sortable" data-sort="matchupRank">${escape(cols.matchupRankLabel || 'Matchup')}${arrow('matchupRank')}</div>`
        : '';
    // An empty header cell over the pick column, present only when the caller wired the group in, so an existing header stays unchanged.
    const pickHeadHtml = cols.showPick ? `<div class="lb-head-pick"></div>` : '';
    // The phone points form's own header labels: Opp, FPts, FP/G, GP, Rank. Hidden at every other width.
    const phoneHeadHtml = cols.showNextGame
        ? `<div class="lb-head-phone"><span class="lb-head-next">Opp</span>`
            + `<span class="lb-head-fp sortable" data-sort="ptsPerGame">FPts${arrow('ptsPerGame')}</span>`
            + `<span class="lb-head-fpg">FP/G</span><span class="lb-head-gp">GP</span>`
            + `<span class="lb-head-pr sortable" data-sort="rank">Rank${arrow('rank')}</span></div>`
        : '';
    return `<div class="lb-row lb-head-row">
        ${pickHeadHtml}
        <div class="lb-head-identity sortable" data-sort="name">${escape(cols.identityLabel || 'Player')}${arrow('name')}</div>
        <div class="lb-head-rank sortable" data-sort="rank" data-tooltip="${rankTip}">${escape(cols.rankLabel || 'Rank')}${arrow('rank')}</div>
        ${matchupRankHeadHtml}
        ${ptsGHtml}
        ${playoffHeadHtml}
        <div class="lb-head-cells">${cellsHtml}</div>
        ${rosteredColHtml}
        ${phoneHeadHtml}
    </div>`;
}

/**
 * @typedef {Object} CompareColour One compared player's colour.
 * @property {number} h The hue, 0 to 360.
 * @property {number} s The saturation, 0 to 1.
 * @property {number} l The lightness, 0 to 1.
 * @property {string} css The colour as a CSS hsl() value.
 */

/**
 * The smaller of the two arcs between two hues on the colour wheel.
 *
 * @param {number} a A hue in degrees.
 * @param {number} b A hue in degrees.
 * @returns {number} The distance in degrees, 0 to 180.
 */
export function hueDistance(a, b) {
    const d = Math.abs((((a - b) % 360) + 360) % 360);
    return d > 180 ? 360 - d : d;
}

/**
 * The colours of the players on the full comparison screen: the look's accent first and then hues spread round the wheel in an order that
 * keeps every pair as far apart as the count allows, so no two compared players ever read alike. The saturation and the lightness are the
 * accent's own, held inside a range that stays legible on the surface.
 *
 * @param {{h: number, s: number, l: number}} accent The look's accent as a hue in degrees, a saturation and a lightness.
 * @param {number} count How many players are compared.
 * @returns {CompareColour[]} One colour per player, in pick order.
 */
export function comparePalette(accent, count) {
    const OFFSETS = [0, 180, 90, 270, 45, 225, 135, 315];
    const s = Math.max(0.5, Math.min(0.9, Number.isFinite(accent.s) ? accent.s : 0.7));
    const l = Math.max(0.45, Math.min(0.7, Number.isFinite(accent.l) ? accent.l : 0.6));
    const out = [];
    for (let i = 0; i < Math.max(0, count); i++) {
        const h = (((accent.h + OFFSETS[i % OFFSETS.length]) % 360) + 360) % 360;
        out.push({ h, s, l, css: `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)` });
    }
    return out;
}

/**
 * The width of the pinned identity column of the phone grid: the headshot, its gap and the cell's padding
 * around the widest name part (a first name or a surname) among the rows on screen, kept between a floor
 * and a ceiling. The surname is never cut, so the column takes what the longest one needs.
 *
 * @param {number[]} nameWidths The measured widths of the name parts, in px.
 * @param {{photo: (number|undefined), gap: (number|undefined), pad: (number|undefined), min: (number|undefined), max: (number|undefined)}} [opts]
 *   The headshot, the gap after it, the horizontal padding, the floor and the ceiling; the drawn defaults when absent.
 * @returns {number} The column width in px, rounded up.
 */
export function pinnedColumnWidth(nameWidths, opts) {
    const o = Object.assign({ photo: 46, gap: 8, pad: 16, min: 120, max: 210 }, opts || {});
    const widest = (nameWidths || []).filter(Number.isFinite).reduce((m, w) => Math.max(m, w), 0);
    return Math.ceil(Math.min(o.max, Math.max(o.min, o.photo + o.gap + o.pad + widest)));
}

/**
 * Reduces a next-game answer to what a phone points row prints, or to null for a dash. A game that has
 * been played, a bye, an undated game and an unknown opponent all read null: the row prints a dash and
 * never a sentence.
 *
 * @param {?{date: ?number, dayLabel: ?string, opponentAbbrev: ?string, home: ?boolean, played: boolean, bye: boolean}} game
 *   The answer of schedule-insight.js's nextGameOf, or null.
 * @returns {?{opponent: string, away: boolean, when: string}} The opponent, whether the club is the
 *   away side (printed with an "@" prefix by the row) and the day and time label; null for a dash.
 */
export function nextGameCell(game) {
    if (!game || game.bye || game.played || game.date === null || game.date === undefined) return null;
    if (!game.opponentAbbrev || !game.dayLabel) return null;
    return { opponent: String(game.opponentAbbrev), away: game.home === false, when: String(game.dayLabel) };
}

/**
 * Formats a game's start as a short weekday and the time with no space before the meridiem, such as
 * "Sat 4:00PM", in the zone the caller names or, by default, the machine's local zone.
 *
 * @param {number} ms The start in epoch milliseconds.
 * @param {{locale: (string|undefined), timeZone: (string|undefined)}} [options] The locale and the
 *   IANA zone; both default to the machine's.
 * @returns {?string} The label, or null for a value that is not a finite number.
 */
export function gameDayTime(ms, options) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return null;
    const d = new Date(Number(ms));
    const opt = options || {};
    const day = d.toLocaleDateString(opt.locale, { weekday: 'short', timeZone: opt.timeZone });
    const time = d.toLocaleTimeString(opt.locale, { hour: 'numeric', minute: '2-digit', timeZone: opt.timeZone }).replace(/\s+/g, '');
    return `${day} ${time}`;
}

// The standalone lens toggle that lived here is gone. The window choice moved into the tab bar's shared pills and Empty Nights became a column measure toggle.
