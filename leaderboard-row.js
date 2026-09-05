// THE LEADERBOARD ROW BUILDER. Pure renderer for one Player Metrics leaderboard row and its header, built to the owner-picked mockup: a fixed identity column, the rank as a slab figure, PTS/G when the league carries it, stat cells sharing the remaining width evenly, and a rostered-percent arc dial. The data lane computes every number; this module only turns the finished ROW MODEL into markup - see tests/fixtures/leaderboard-row.md for the frozen shape. PURITY CONTRACT, same as rank-engine.js and seasons-band.js: no imports, no AppState, no DOM, no fetch. escapeHtml, avatarHtml, injuryBadgeHtml and sortArrowHtml all arrive via opts rather than an import from utils.js/images.js, because utils.js imports state.js (the AppState singleton) - see seasons-band.js's own comment on the same choice. Local fallbacks exist below so a caller that does not care (a quick console check, this module's own tests) does not have to supply real ones. Every opt's signature matches the real function it stands in for, so wiring the real thing in is a direct pass, not an adapter.
export function escapeHtmlLocal(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// "84th percentile" reads as a measured fact. Matches seasons-band.js's own ordinal() and draft-view.js's exactly - a third small copy for the reason the file header gives: this module cannot import either of those without dragging in what makes them impure.
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

// Renders nothing, the same "no logo, exactly today's layout" default images.js's own proTeamLogoUrl/buildProTeamLogoHtml draws for an unmapped abbreviation - unlike avatarHtmlLocal's initials tile, a missing team logo has no fallback glyph to fall back to.
function logoHtmlLocal() {
    return '';
}

// R5: a D/ST row's own stand-in for images.js's buildProTeamCrestHtml - initials, same fallback shape avatarHtmlLocal already draws for a human row, so an unwired caller sees the identical "no image" tile either way.
function proTeamCrestHtmlLocal(abbrev) {
    return `<span class="lb-avatar-fallback">${escapeHtmlLocal(abbrev || '?')}</span>`;
}

// An unwired injury badge renders nothing rather than guessing at a status vocabulary this module does not own - silently omitting a nonessential badge is the safe default, not a real badge with invented markup.
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
        // R1/S49: preseason has "useless" data for a drill-down (the owner's own word) - no games yet to project a matchup or a form arrow from. Default true so every existing caller and test (a real season, always interactive) needs no change; the caller states `false` only for the one season state that has nothing to open.
        interactive: o.interactive !== false,
    };
}

// percentileVar's own clamp (utils.js), copied rather than imported for the same purity reason as everything else here. --pct is set as a bare number; the CSS side (dashboard.css, the shared tint rule.dominance-heatmap td.dh-cell,.stat-chip,.dr-cat,.lb-cell) does the mixing.
function clampPct(pct) {
    return Math.max(0, Math.min(100, Number(pct)));
}

// Rostered-dial ring geometry. r=15 in a 36x36 viewBox leaves room for a 3px stroke without clipping, the same box a standard SVG progress-ring trick uses.
const DIAL_R = 15;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_R;

// The dial has exactly two tones (the mockup names only these two): amber for a contested share, green everywhere else - which does mean a nearly-unowned player (5%) reads the same "settled" green as a near-universal one (95%). That is what "green when high and settled, amber when contested ~30-70%" says taken literally, and a three-state ramp is not in the approved mockup.
const ROSTERED_CONTESTED_LOW = 30;
const ROSTERED_CONTESTED_HIGH = 70;

// A move under this is not news (matches the leaderboard's existing under-a-point rule for the same figure, players.js's rosterCellHtml) - the sub-line stays off the dial rather than printing churn nobody asked to read.
const ROSTERED_CHANGE_NEWS = 5;

function metaLineHtml(model, escape) {
    const parts = [model.proAbbrev, model.posLabel, model.gpLabel].filter(Boolean).map(escape);
    return parts.join(' · ');
}

// item 2's own spec: "a compare affordance on leaderboard rows plus one inside the drill- down" - the drill-down's "+ Compare" already shipped; this is the row-level half. A row-hover icon rather than a persistent label, since a label on every one of a dense table's ~50 rows would out-shout the row's own figures - the same "chrome earns its keep only on demand" call.rank-explainer-trigger already makes for the header. The click target carries no player id of its own; the real caller (players.js) reads it off the row's own [data-player-id], the same way every other per-row control here already does.
function compareTriggerHtml(model, o) {
    const tip = o.escapeHtml(`Compare ${model.name} with another player`);
    return `<button type="button" class="lb-compare-trigger" data-tooltip="${tip}" aria-label="${tip}">&#8646;</button>`;
}

// R5: a football D/ST row's whole identity IS its club - one large crest at the avatar's own size, no greyed player tile behind it (there is no player to photograph) and no second small logo repeating the same club beside the name (that logo exists elsewhere to say "this human plays for a club"; here the row already IS the club). posLabel === 'D/ST' is the same literal string players.js's own SECONDARY_LABEL table already uses for this role - not a guess coined here.
function isProTeamUnit(model) {
    return model.posLabel === 'D/ST';
}

function identityHtml(model, o) {
    const escape = o.escapeHtml;
    const injuryHtml = o.injuryBadgeHtml(model.injuryStatus);
    const faHtml = model.isFreeAgent ? '<span class="lb-fa-chip">FA</span>' : '';
    if (isProTeamUnit(model)) {
        return `<div class="lb-identity">
            <span class="lb-avatar-slot">${o.proTeamCrestHtml(model.proAbbrev)}</span>
            <span class="lb-identity-text">
                <span class="lb-name-line"><span class="lb-name">${escape(model.name)}</span>${injuryHtml}${faHtml}</span>
                <span class="lb-meta">${metaLineHtml(model, escape)}</span>
            </span>
            ${o.interactive ? compareTriggerHtml(model, o) : ''}
        </div>`;
    }
    // : the pro-team logo sits beside the NAME, not folded into the meta line's own text - proAbbrev already reads there as a word ("DET"), and the logo is the same fact said as a mark, not a second copy of it. o.logoHtml renders nothing for a null proAbbrev or an unmapped one, so a row with no club to show draws exactly as it did before this.
    const logoHtml = o.logoHtml(model.proAbbrev);
    return `<div class="lb-identity">
        <span class="lb-avatar-slot">${o.avatarHtml(model.id, model.name)}</span>
        <span class="lb-identity-text">
            <span class="lb-name-line">${logoHtml}<span class="lb-name">${escape(model.name)}</span>${injuryHtml}${faHtml}</span>
            <span class="lb-meta">${metaLineHtml(model, escape)}</span>
        </span>
        ${o.interactive ? compareTriggerHtml(model, o) : ''}
    </div>`;
}

// rank.label is the bare rank number, never pre-prefixed - this function owns the T-vs-# choice, the same split seasons-band.js's own rank phrase makes off row.tied. gold is a caller decision (not inferred from label === 1 here) so a tie for first can be answered either way without this module guessing. The zero-games floor unranks a real fraction of a pool with Minimum Games off (measured by the data lane: 59% of one real pool) - this is by-design engine behaviour, not a missing value, so null is a real state this function has to draw, not an edge case to guard against. The dash and its hover text are the exact strings the existing table's rank-unranked cell already uses (players.js) - two surfaces telling the same "no games, nothing to rank on" fact should say it identically, not coin a second wording for the same case.
function unrankedHtml(o) {
    return `<div class="lb-rank"><span class="lb-rank-unranked" data-tooltip="${o.escapeHtml('No games played, nothing to rank on')}">-</span></div>`;
}

function rankHtml(rank, o) {
    if (!rank) return unrankedHtml(o);
    const prefix = rank.tied ? 'T' : '#';
    const goldCls = rank.gold ? ' lb-rank-gold' : '';
    return `<div class="lb-rank"><span class="lb-rank-figure${goldCls}">${prefix}${o.escapeHtml(String(rank.label))}</span></div>`;
}

// S41/F1 (Amendment 5): the Matchup column beside Overall - category wins a week this line is expected to swing against the league's own MEASURED margins (matchup-rank.js, O38). A row's own `null` means the model could not measure this player (too few of the pool's categories had a figure to work with) - the same "real state, not an edge case" the Overall rank's own zero-games floor already established for `unrankedHtml` above, so it gets the identical dash-plus-tooltip treatment rather than a second unranked vocabulary. WHETHER THE COLUMN EXISTS AT ALL is the caller's decision (the `showMatchupRank` flag on buildLeaderboardRowHtml/buildLeaderboardHeaderHtml, the same idiom `lens` already uses for the time column) - a whole LEAGUE can be unable to support this (roto, points, too few decided matchups), which is a page-level fact this per-row model has no way to carry.
function matchupRankUnrankedHtml(o) {
    return `<div class="lb-mrank"><span class="lb-mrank-unranked" data-tooltip="${o.escapeHtml('Not enough categories measured to rank this player')}">-</span></div>`;
}

function matchupRankHtml(matchupRank, o) {
    if (!matchupRank) return matchupRankUnrankedHtml(o);
    const prefix = matchupRank.rank.tied ? 'T' : '#';
    const wpw = Number(matchupRank.winsPerWeek);
    // A tiny negative figure (a player who is a net drag, barely) rounds to "-0.00" at two decimals, which reads as a formatting bug rather than the real, small negative it is - "0.00" says the same thing without the confusing sign on a value that IS zero at this precision.
    let sub = wpw.toFixed(2);
    if (sub === '-0.00') sub = '0.00';
    return `<div class="lb-mrank"><span class="lb-mrank-figure">${prefix}${o.escapeHtml(String(matchupRank.rank.label))}</span><span class="lb-mrank-sub">${o.escapeHtml(`${sub}/wk`)}</span></div>`;
}

// The PTS/G column's shape depends on whether this is a points league. `total` (ESPN's appliedTotal) is null for a category league, in which case this cell is unchanged from before `total` existed - ptsPerGame alone, or nothing. In a points league total is the headline figure this column exists to show at all, so it takes the slab treatment (matching the rank figure's font-headline) and ptsPerGame drops to a muted line underneath it - two facts about the same column, not two competing headlines.
function totalsCellHtml(model) {
    const hasTotal = model.total !== null && model.total !== undefined;
    const hasPtsG = model.ptsPerGame !== null && model.ptsPerGame !== undefined;
    if (!hasTotal) {
        return hasPtsG ? `<div class="lb-ptsg">${Number(model.ptsPerGame).toFixed(1)}</div>` : '';
    }
    const secondaryHtml = hasPtsG
        ? `<span class="lb-ptsg-secondary">${Number(model.ptsPerGame).toFixed(1)}</span>`
        : '';
    return `<div class="lb-ptsg lb-ptsg-total"><span class="lb-total-figure">${Number(model.total).toFixed(1)}</span>${secondaryHtml}</div>`;
}

// cell.pct arrives ALREADY inverse-aware from the rank engine (a low ERA scores a HIGH pct) - this function never re-derives or flips it from cell.inverse, which exists on the model purely as a documented fact for whoever reads the contract, not as an input to this rendering. The one string the rest of the app already uses to mean "no figure at all" for an off-role category (a QB's rushing/receiving cells, an OF's pitching ones) - not this module's own invention. A cell carrying it is never guessed at further; it just gets the same faint, unboxed treatment.dr-cat-none/.rank-unranked already give the same fact elsewhere.
const NO_FIGURE = '-';

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
    return `<div class="${cls.join(' ')}"${style} data-tooltip="${tip}">${escape(cell.value)}</div>`;
}

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
        ? `<span class="lb-dial-change">${change >= 0 ? '▲' : '▼'}${Math.round(Math.abs(change))} this week</span>`
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

// Oxford comma per VOICE - two parts read "a and b", three or more "a, b, and c". Matches draft-view.js's own playoffHoverFor exactly (a third small copy, same purity reason every other one in this file has: draft-view.js is deep in AppState and the DOM).
function oxford(parts) {
    return parts.length > 2
        ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
        : parts.join(' and ');
}

const TREND_GLYPH = { up: '↗', down: '↘', flat: '→' };
const TREND_WORD = { up: 'rising', down: 'falling', flat: 'steady' };

// "{club} plays 4 games in 22, 2 in 23, and 8 in 24. Those rounds run 7, 7, and 18 days. Recent form: rising." - reuses draft-view.js's own established sentence for the games clause (the module that first proved the round-length caveat matters), reimplemented locally for the same purity reason as oxford() above. The second sentence is not decoration: schedule-insight.md's own worked example is ESPN folding the pro season's tail into the final round, where a bare count reads the opposite of the truth unless the round lengths ride along whenever they differ.
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

// The playoff-window lens: one compact column, present only when the data lane carries a bracket to project against. The projected total takes the same slab treatment totalsCellHtml gives a points league's season total, because it is the same kind of fact - the number this column exists to rank by - and the round-by-round breakdown is counts and days only, never a percentage or a word like "favourable" (schedule-insight.md's own rule, carried over verbatim).
function playoffHtml(model, o) {
    const p = model.playoff;
    if (!p) return '';
    const totalGames = p.byRound.reduce((sum, r) => sum + r.games, 0);
    const roundsFigure = `${p.byRound.map(r => r.games).join(' · ')} game${totalGames === 1 ? '' : 's'}`;
    const trendHtml = p.trend
        ? `<span class="trend-icon trend-${p.trend}">${TREND_GLYPH[p.trend]}</span>`
        : '';
    // schedule-insight.js (playoffOutlook, 7114175) reports `projected: null` for a player with no per-game projection to multiply against real playoff games - a legitimately unprojectable player (a September call-up, a rookie ESPN has not modelled), not a data gap. The counts are still real, so the round-by-round figure stays; the slab falls back to `rank` (a category league's own answer - ten per-game numbers have no single total to project, so the engine ranks the window-projected line over the qualified pool instead) and only omits outright when NEITHER exists. Never a fabricated 0.0 or a dash wearing the slab's own styling either way - a dash there would read as "this player has no playoff games", which is exactly the fact this row does have.
    const hasProjected = p.projected !== null && p.projected !== undefined;
    // The row-rank style, not a second rank vocabulary: `#` for a solo rank, `T` for a tied one - the same split rankHtml (this file's own Rank column) makes off `rank.tied`.
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

// : "games left" for the matchup you're setting a lineup against, right now or next - the same slot the playoff lens occupies, not a fourth column. `lens` picks which of the row's three mutually-exclusive time facts (playoff / window / next) that slot shows; the caller's toggle state decides, this module has none of its own. Defaults to 'playoff' so every existing caller (and every test above this comment) keeps behaving exactly as it did before this lens existed. A single-game window (most football rows: one game per week) makes "N of 1 left" read like a player who hasn't started yet even on their bye-free, ordinary week - the fraction is honest but the ENGLISH is silly at the one value every football row actually carries. Below that, the compact figure names the state instead of counting it ("Upcoming" / "Played"); the hover still spells out the real game and day, so nothing about the underlying fact is hidden, only how the glanceable figure phrases a fraction of one. item 2/O11: `rest` prints `games` bare ("23"), never a fraction - a window running to the league's cutoff is not a thing being counted down within a round, so "N of M left" has no meaning there (the mockup's own frame one, read against frame two's "3 of 6" for This matchup).
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

// offNight/twoGameDays are SUFFIXES on the figure, and a zero is OMITTED, never printed - the mockup's own proof (Burleson's cell carries neither suffix, "3 of 6 left" alone) and the contract's own rule that null and 0 render identically here (the model keeps them apart, this renderer does not need to). Two colour tokens the mockup names: off-night games in the success tone (a lineup-friendly quiet night), two-game days in the warning tone (a day worth planning around, not a problem).
function windowSuffixHtml(win, o) {
    const parts = [];
    if (win.offNight) parts.push(`<span class="lb-window-off">${o.escapeHtml(`${win.offNight} off`)}</span>`);
    if (win.twoGameDays) parts.push(`<span class="lb-window-dbl">${o.escapeHtml(`${win.twoGameDays} dbl`)}</span>`);
    if (!parts.length) return '';
    return `<span class="lb-window-suffix">${parts.join(' &middot; ')}</span>`;
}

// "3 games this matchup: 1 on Tue, 1 on Thu, and 1 on Sat. 2 left." - byPeriod's own `period` field is already the printable day label (the same "ready-to-print, not this module's job" convention gpLabel established), so this function only joins and counts, never formats a date. The starts clause is appended only when the row carries one (a pitcher) - a hitter's window has no second number to report.
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

// S14: "nights with an open seat this matchup" - a DIFFERENT SHAPE than window/next/rest (`{ nights, count }`, not a games window), so it gets its own figure rather than reusing windowFigureHtml. Words match the contract exactly: "an open seat", never "started" - nobody has set a future night's lineup.
function openSeatsHtml(openSeats, o) {
    if (!openSeats) return '';
    const word = openSeats.count === 1 ? 'night' : 'nights';
    const tip = o.escapeHtml(`${openSeats.count} ${word} with an open seat this matchup.`);
    return `<div class="lb-window" data-tooltip="${tip}"><span class="lb-window-figure">${o.escapeHtml(String(openSeats.count))}</span></div>`;
}

// The dispatcher: 'playoff' keeps the exact markup/classes playoffHtml already renders (untouched, so every playoff test above stays green - the toggle no longer offers it, item 2, but the model field and this branch are not this task's to remove); 'window'/'next'/'rest' render off model.window / model.next / model.rest into a sibling class (.lb-window, not.lb-playoff) so a CSS rule can size both without either lens pretending to be the other's tests. 'openSeats' (S14) reads model.openSeats, the one field here that is not a games window at all.
function timeLensHtml(model, lens, o) {
    if (lens === 'playoff') return playoffHtml(model, o);
    if (lens === 'openSeats') return openSeatsHtml(model.openSeats, o);
    const win = model[lens];
    if (!win) return '';
    const tip = windowHoverText(win, WINDOW_SUBJECT_LABEL[lens], o);
    return `<div class="lb-window" data-tooltip="${tip}">${windowFigureHtml(win, lens, o)}</div>`;
}

// One leaderboard row. Every optional piece (PTS/G, a stat cell's tint, the rostered dial, the playoff/window lens) omits itself outright rather than rendering an empty placeholder - "no dead bands" applies to a whole missing column exactly as it does to unused cell width. `lens` is the addition (see timeLensHtml above): a DEFAULT PARAMETER, not `lens || 'playoff'` - the distinction matters once a real caller has a genuine three-state choice (nothing picked yet, honestly). Omitting the argument (every existing caller, every test above this comment) still defaults to 'playoff'; passing it explicitly as `null` (a real caller's "no lens chosen") renders no lens column at all rather than falling back to one.
export function buildLeaderboardRowHtml(model, opts, lens = 'playoff', showMatchupRank = false) {
    const o = resolveOpts(opts);
    const cellsHtml = (model.cells || []).map(c => cellHtml(c, o)).join('');
    // R1/S49: "no pointer, no hover affordance, the click inert" (the ruling's own words) -.lb-row-inert is a pure marker for the caller's own CSS (cursor, hover background); this module draws no behavior of its own, so there is no click handler here to skip in the first place - the caller (players.js) is the one that decides whether to attach one at all.
    const inertCls = o.interactive ? '' : ' lb-row-inert';
    return `<div class="lb-row${inertCls}" data-player-id="${o.escapeHtml(String(model.id))}">
        ${identityHtml(model, o)}
        ${rankHtml(model.rank, o)}
        ${showMatchupRank ? matchupRankHtml(model.matchupRank, o) : ''}
        ${totalsCellHtml(model)}
        ${lens ? timeLensHtml(model, lens, o) : ''}
        <div class="lb-cells">${cellsHtml}</div>
        ${rosteredHtml(model.rostered, o)}
    </div>`;
}

// The header row, sortable exactly as the current table's <th class="sortable" data-sort="..."> pattern - same data-sort keys buildLeaderboardRowHtml's model implies (name, rank, ptsPerGame, each cell's own id, rostered), so a caller's existing sort-click handler needs no new cases. columns: identityLabel, rankLabel, ptsPerGameLabel, rosteredLabel, playoffLabel - header text, default to the plain English name of the column when omitted. showPtsPerGame - render the PTS/G header cell at all (default false) showRostered - render the Rostered header cell (default true) showPlayoff - render the Playoff header cell (default false) - the item 3.2 lens. Equivalent to timeLens: 'playoff'; kept as its own flag so every existing caller (and every test above this comment) needs no change now that the column also answers to the lens. timeLens - 'playoff' | 'window' | 'next' | null (default) - which of the three lenses the shared column header names, overriding showPlayoff's fixed "Playoff" label. timeLensLabel overrides the per-lens default ("Playoff" / "This Matchup" / "Next Matchup") the same way the other *Label options override theirs. cells - [{id, label}], the same category set and order the rows carry
const TIME_LENS_DEFAULT_LABEL = { playoff: 'Playoff', window: 'This Matchup', next: 'Next Matchup', rest: 'Rest of Season', openSeats: 'Empty Nights' };

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

    // S18: the header's own hover, one line, distinct from the click-to-open explainer (players.js appends that button into this same cell) - a reader who never clicks still learns the pool the number is scoped to before wondering why it moved when a position filter was picked.
    const rankTip = escape('Ranks against the whole group. Choosing a position ranks against that position instead.');
    // S41/F1: the Overall header keeps its plain default label unless the caller renames it (matchupRankLabel/showMatchupRank existing side by side with it) - F1's own mockup labels the two headers "Overall" and "Matchup" once the second column exists, so the caller passes rankLabel: 'Overall' explicitly rather than this module guessing a rename from a sibling flag.
    const matchupRankHeadHtml = cols.showMatchupRank
        ? `<div class="lb-head-mrank sortable" data-sort="matchupRank">${escape(cols.matchupRankLabel || 'Matchup')}${arrow('matchupRank')}</div>`
        : '';
    return `<div class="lb-row lb-head-row">
        <div class="lb-head-identity sortable" data-sort="name">${escape(cols.identityLabel || 'Player')}${arrow('name')}</div>
        <div class="lb-head-rank sortable" data-sort="rank" data-tooltip="${rankTip}">${escape(cols.rankLabel || 'Rank')}${arrow('rank')}</div>
        ${matchupRankHeadHtml}
        ${ptsGHtml}
        ${playoffHeadHtml}
        <div class="lb-head-cells">${cellsHtml}</div>
        ${rosteredColHtml}
    </div>`;
}

// The old lens toggle lived here through S29 - a standalone three/four-way segmented control the leaderboard drew beside itself. O27/S30 removed it: the window choice (This matchup / Next / Rest) moved into the tab bar's own shared Current/Next/Rest-of-season pills (controls.js, AppState.ahead), and Empty Nights became a column measure toggle (players.js) rather than a fourth window state. buildTimeLensToggleHtml and its TIME_LENS_OPTIONS table are gone with it - nothing else called either.
