// League History's rendering. The math is in history.js and is pure; this file only turns its output into markup and owns the loading state. PLACEMENT: a third top-level tab, not a league-level header above the tabs. The no-scroll rule is the reason. A header band would cost every OTHER tab vertical space permanently - Team Metrics already fights for it, and My Team's roster band is sized from what is left after the summary - so a persistent history strip would shrink three working views to decorate a fourth. As a tab it costs one button in a row that already exists and takes the full view height when it is the thing being read. It also matches the drill-down the entry asks for: a season row loads that season in today's dashboard, which is a tab switch rather than a navigation. Everything a roto season cannot answer is stated rather than blanked. The measured league changed format partway through its life, so "no head-to-head record" is a normal state here, not an error.
import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, RATE_COMPONENTS, INVERSE_STATS, POSITION_MAPS, SLOT_POSITION_MAPS } from './state.js';
import { escapeHtml, openingSortDir, registerLeagueView, splitStatIdsByRole, attachDataTooltips, leagueSeasonYears } from './utils.js';
import { playerRoleGroups, computeEligiblePositions } from './players.js';
import { buildTeamLogoHtml, wirePlayerAvatars } from './images.js';
import { sampleLogoColour, darkenUntilContrast, toCssRgb, parseCssColour, contrastRatio } from './logo-colour.js';
import { loadHistorySeasons, loadHistoryPools, loadHistoryOwnership } from './api.js';
import {
    summarizeSeason, buildFranchises, allTimeRecords, headToHead, categoryUnion,
    buildCareers, careerValue, sortCareers, categoryRowHeight,
    rivalryDetail, rivalrySplit, RIVALRY_CARD_SECTIONS,
    recordText, defaultFranchiseIndex, coverageSentence, runSpanText, pennantLines, franchiseKeyOf
} from './history.js';

// No column chosen yet means the order buildCareers already returns - longest tenure first, which is the question a career table answers before anybody clicks anything.
const HINT_BREAK = String.fromCharCode(10);
const defaultSort = () => ({ key: null, dir: 'desc' });
// One per role group, since the two groups do not share columns.
const defaultSorts = () => ({ primary: defaultSort(), secondary: defaultSort() });
const emptyCareers = () => ({ status: 'idle', rows: [], loaded: 0, total: 0, years: [], phase: 'pools', refining: 0, deferred: [], logYears: null, owners: {} });
let state = { key: null, status: 'idle', seasons: [], payloads: {}, franchises: [], loaded: 0, total: 0, gridRow: null, rivalKey: null, careerSort: defaultSorts(), careerGroup: 'primary', focusPane: 'h2h', careers: emptyCareers() };

export function resetHistoryView() {
    state = { key: null, status: 'idle', seasons: [], payloads: {}, franchises: [], loaded: 0, total: 0, gridRow: null, rivalKey: null, careerSort: defaultSorts(), careerGroup: 'primary', focusPane: 'h2h', careers: emptyCareers() };
}

// Registered here rather than called from the fetch path, so this tab cannot be the one somebody forgets on the next league switch. History belongs to the league that was on screen, so a new league starts from nothing rather than showing the previous league's franchises while its own seasons load.
registerLeagueView('history', { reset: resetHistoryView });

const yearList = (years) => years.join(', ');

// One line, stated once, wherever a number covers fewer seasons than the league has lived. The alternative is a footnote nobody reads under a total that quietly means something else. The sentence is the owner's own and ships as written; only the year list is computed.
function coverageNote(countedYears, total) {
    if (!countedYears.length) return 'No season in this league kept a win-loss record.';
    if (countedYears.length === total) return '';
    return `W-L-T is only applicable for ${yearList(countedYears)} given roto leagues are not head to head.`;
}

// The pennant rail. The champions read vertically down the left, one shape per title, which is the pennant wall stood on its end. The shape follows the sport: baseball hangs felt pennants and hockey raises rafter banners, both the same clip-path construction, per the ruling. Until the Boxscore theme lands the rail wears the current neutral chrome - this entry builds the structure, P2 brings the dressing. A season with no champion is the season being played, and it hangs greyed rather than being left out. A wall with a gap where this year should be reads as a bug; a grey shape reads as a title nobody has won yet.

// THE CHAMPION'S COLOUR ON THE CLOTH. Runs AFTER the rail is in the DOM and paints by setting one custom property per flag, so the markup builder stays synchronous and a sample that never arrives leaves the flag as it was. That fallback is not a consolation: an undyed flag is theme black on both halves, which is exactly what a team with no logo already looks like, so the wall degrades into a look it already has. WHY THE GOLD DECIDES HOW DARK THE DYE GETS. The pennant's legend is centred on the shape, so the gold type straddles the fold and sits on the sampled half as much as the dark one. A team whose logo is bright yellow would put gold on gold. So every sample is darkened until the gold clears 4.5:1 against it - measured, in a loop, the same discipline the brass plate needed - and a sample that cannot get there even at black gives up and leaves the flag undyed.
const DYE_CONTRAST_FLOOR = 4.5;

// RUNG 3: THE TEAM'S OWN CHART COLOUR. A team whose logo cannot be sampled - refused host, tainted canvas, or a logo with no colour in it at all - still HAS a colour in this app: the one its trend line, its legend swatch and its heatmap dot have always used. Borrowing it makes the wall agree with every other surface instead of inventing a shade for the occasion. Matched through franchiseKeyOf, the same function the history module keys franchises by, so a champion is found by SWID rather than by a team id that may mean a different team this season.
function chartColourForFranchise(key) {
    const teams = (AppState.apiData && AppState.apiData.teams) || [];
    for (const team of teams) {
        if (franchiseKeyOf(team) === key) {
            const colour = AppState.teamColorMap[team.id];
            if (colour) return parseCssColour(colour);
        }
    }
    return null;
}

async function dyeChampionFlags(container) {
    // Boxscore only. Modern's wall is its own neutral chrome and has neither felt nor gold to reason about; dyeing it would be inventing a look nobody ruled.
    if (document.documentElement.dataset.style !== 'boxscore') return;
    const flags = [...container.querySelectorAll('.lh-flag[data-franchise]')];
    if (!flags.length) return;

    const gold = parseCssColour(getComputedStyle(document.documentElement).getPropertyValue('--gold'));
    if (!gold) return;

    await Promise.all(flags.map(async (flag) => {
        // The ladder, in order: the logo's own colour, then the team's chart colour, then nothing - and "nothing" is a look rather than a failure, see the blank felt in dashboard.css.
        const sampled = await sampleLogoColour(flag.dataset.logo)
            || chartColourForFranchise(flag.dataset.franchise);
        if (!sampled) {
            if (flag.isConnected) flag.classList.add('lh-flag-blank');
            return;
        }
        const fixed = darkenUntilContrast(sampled, gold, DYE_CONTRAST_FLOOR);
        // Ran out of room before the gold passed - the type would be unreadable on any version of this colour, so the flag keeps theme black rather than wearing an illegible dye.
        if (!fixed || !fixed.passed) return;
        // The element may have been re-rendered out from under the await; setting a property on a detached node is harmless but pointless, and skipping it keeps the intent obvious.
        if (!flag.isConnected) return;
        flag.style.setProperty('--flag-dye', toCssRgb(fixed.rgb));

        // THE MONOGRAM NEEDS ITS OWN DARKENING, and finding that out is why this is measured rather than reasoned. The letters sit on the BRASS badge, not on the cloth, and brass is a light metal: the cloth dye that clears 4.5:1 against the gold measured 2.05:1 against brass, which is not readable. An earlier version of this code asserted in a comment that one darkening covered both. It does not, and only the measurement said so.
        const badge = flag.querySelector('.lh-flag-badge');
        const brass = badge && parseCssColour(getComputedStyle(badge).backgroundColor);
        if (!brass) return;
        const ink = darkenUntilContrast(sampled, brass, DYE_CONTRAST_FLOOR);
        // If the letters cannot be made legible on brass they keep the theme ink rather than wearing a colour nobody can read - the badge is small and the name is under the flag.
        if (ink && ink.passed) flag.style.setProperty('--flag-dye-ink', toCssRgb(ink.rgb));
    }));
}

function railHtml(seasons, nameOf) {
    // The champion's own franchise record, for its badge. A historical champion uses the logo from the season it won, which is already in hand - no extra fetch for the rail.
    const byKey = new Map(state.franchises.map(f => [f.key, f]));
    const shapes = [...seasons].sort((a, b) => b.year - a.year).map(season => {
        const decided = !!season.championKey;
        const champ = decided ? byKey.get(season.championKey) : null;
        const how = season.format === 'roto' ? 'Roto' : 'Playoffs';
        const tone = decided ? (season.format === 'roto' ? ' lh-flag-roto' : ' lh-flag-bracket') : ' lh-flag-open';
        // The pennant IS the season drill-down. L2's three zones have no seasons list, and clicking a season to load it in the dashboard is not chrome worth losing - the flag already names the year, so it carries the click the old table row used to. The name the pennant hangs, split the way a ballclub's pennant splits it (pennantLines). Built for every style and hidden by Modern's own rules rather than switched on data-style here: the style can change under a rendered rail, and re-rendering League History on a settings change is a dependency this file should not have.
        const champName = decided ? nameOf(season.championKey) : 'Not decided';
        const lines = pennantLines(champName);
        // The plate's word, which is the FORMAT the title was won under. "Bracket" rather than the tooltip's "Playoffs" per the P2 ruling - a plate is a label, and the label is the format.
        const plate = decided ? (season.format === 'roto' ? 'Roto' : 'Bracket') : 'Open';
        // The logo url rides on the flag so the dye pass below can find it without walking the franchise list a second time. The logo url and the franchise key both ride on the flag: the first is what gets sampled, the second is how rung 3 finds the team's chart colour. A champion with NO logo still carries the key, which is why the dye pass looks for [data-franchise] rather than for a logo - a logo-less champion has a chart colour like everyone else.
        const dyeSrc = (champ && champ.logo ? ` data-logo="${escapeHtml(champ.logo)}"` : '')
            + (decided && season.championKey ? ` data-franchise="${escapeHtml(season.championKey)}"` : '');
        return `<div class="lh-flag${tone} lh-season-row" data-year="${season.year}" tabindex="0" role="button"${dyeSrc}
                     title="${escapeHtml(decided ? how : 'Not decided')} - click to load ${season.year} in the dashboard">
                    <div class="lh-flag-shape">${champ ? buildTeamLogoHtml(champ.name, champ.logo) : ''}<span class="lh-flag-legend"><span class="lh-flag-loc">${escapeHtml(lines.top)}</span><span class="lh-flag-nick">${escapeHtml(lines.nick)}</span><span class="lh-flag-raised">${season.year}</span></span></div>
                    <div class="lh-flag-year"><span class="lh-flag-plate-year">${season.year}</span><span class="lh-flag-how">${escapeHtml(plate)}</span></div>
                    <div class="lh-flag-name">${escapeHtml(champName)}</div>
                </div>`;
    }).join('');

    // The league's vitals close the rail, the way the shelf line closes the wall in. Careers is only counted once the pools are in - before that the rail says what it knows and no more.
    const vital = (label, value) => `<div class="lh-vital"><span class="lh-vital-n">${value}</span><span class="lh-vital-l">${escapeHtml(label)}</span></div>`;
    const vitals = [
        vital(seasons.length === 1 ? 'season' : 'seasons', seasons.length),
        vital(state.franchises.length === 1 ? 'franchise' : 'franchises', state.franchises.length)
    ];
    if (state.careers.status === 'done') {
        vitals.push(vital(state.careers.rows.length === 1 ? 'career' : 'careers', state.careers.rows.length));
    }
    return `<div class="lh-rail-flags">${shapes}</div>
            <div class="lh-rail-vitals">${vitals.join('')}</div>`;
}

function standingsHtml(records, totalSeasons) {
    const note = coverageNote(records.countedYears, totalSeasons);
    const rows = records.rows.map(r => {
        const pct = r.winPct === null ? '-' : r.winPct.toFixed(3).replace(/^0/, '');
        const rec = r.recordSeasons ? recordText(r.wins, r.losses, r.ties) : '-';
        return `<tr>
                    <td class="lh-name">${escapeHtml(r.name)}</td>
                    <td>${r.titles || ''}</td>
                    <td>${r.seasonsPlayed}</td>
                    <td>${rec}</td>
                    <td>${pct}</td>
                </tr>`;
    }).join('');
    return `<div class="lh-block">
                <div class="lh-block-head">All-time standings</div>
                ${note ? `<div class="lh-note">${escapeHtml(note)}</div>` : ''}
                <div class="lh-scroll">
                    <table class="lh-table">
                        <thead><tr><th>Franchise</th><th>Titles</th><th>Seasons</th><th>W-L-T</th><th>Win%</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
}

// THE RIVALRY PANE. The pane is a list of opponents beside a detail card for whichever one is selected, and a row is ALWAYS selected - which is what makes the second column pull its weight instead of waiting for a click that may never come. The season pills are gone. They asked the reader to pick a year before the pane would say anything about it, and the card now shows every season at once as a bar apiece, which is the same fact without the question. Seasons live in the card. Every size here is arithmetic over COUNTS and constants - the rule: rivalrySplit decides the column ratio from the opponent count. The card no longer budgets its own contents - all five facts render in every league, and a pane too short for them scrolls the card rather than dropping any.

function rivalryRowsHtml(opponents, rowFor, selectedKey) {
    return opponents.map(opp => {
        const rec = rowFor(opp);
        const on = opp.key === selectedKey ? ' selected' : '';
        const common = `data-rival="${escapeHtml(opp.key)}" tabindex="0" role="button" aria-pressed="${opp.key === selectedKey}"`;
        // An opponent never played is stated, not skipped. A franchise that joined last season has never met the one that left two years ago, and that is history rather than missing data.
        if (!rec) {
            return `<div class="lh-h2h-row lh-h2h-unmet${on}" ${common}>
                        <div class="lh-h2h-opp" title="${escapeHtml(opp.name)}">${escapeHtml(opp.name)}</div>
                        <div class="lh-h2h-track lh-h2h-track-empty">Never met</div>
                        <div class="lh-h2h-rec">-</div>
                    </div>`;
        }
        const seg = (cls, n) => (n > 0 ? `<span class="${cls}" style="flex-grow:${n}"></span>` : '');
        const record = recordText(rec.w, rec.l, rec.t);
        return `<div class="lh-h2h-row${on}" ${common}>
                    <div class="lh-h2h-opp" title="${escapeHtml(opp.name)}">${escapeHtml(opp.name)}</div>
                    <div class="lh-h2h-track">
                        ${seg('lh-h2h-win', rec.w)}${seg('lh-h2h-tie', rec.t)}${seg('lh-h2h-loss', rec.l)}
                    </div>
                    <div class="lh-h2h-rec">${escapeHtml(record)}</div>
                </div>`;
    }).join('');
}

// The card's facts, in the owner's fixed order. Each is derived from records already in hand - the meetings the schedules carry and the titles the standings already counted - so the card costs no fetch of any kind. A fact that cannot be derived is stated as none rather than approximated. THE FACT VALUES ABBREVIATE. A fact is a line in the narrowest column on the tab, and "Playoff meetings: 1 - Ice Wolves 0, Rink Rats 1" spent most of it on names the reader has just read in the card's own heading. The heading and the list rows keep their full names - the heading IS the title, and the rows have the width for it.
function rivalryFactsHtml(detail, meShort, oppShort, titles) {
    const nameFor = (side) => (side === 'a' ? meShort : oppShort);
    const fact = (label, value) =>
        `<div class="lh-riv-fact"><span class="lh-riv-fact-l">${escapeHtml(label)}</span><span class="lh-riv-fact-v">${escapeHtml(value)}</span></div>`;

    // EVERY FACT NAMES ITS SUBJECT, in the one "by NAME" form. "Won 2 straight" was ambiguous in the rendered card: the card's own heading is the OPPONENT's name, so a bare Won/Lost read as a claim about them while it was in fact about the franchise in the pager above.
    const streakText = detail.streak
        ? `${detail.streak.count} straight by ${nameFor(detail.streak.side)}`
        : 'None, the last meeting was a tie';
    // The coordinate first, then the marker, then who won - the owner's ruled order. Matchup is capitalised to match the run span beside it, which has always written it that way.
    const last = detail.last;
    const when = last ? `${last.year} Matchup ${last.period}${last.playoff ? ', Playoffs' : ''}` : '';
    const lastText = !last
        ? 'None'
        : (last.result === 'tie' ? `${when}, tied` : `${when}, won by ${nameFor(last.result)}`);
    const rows = [
        fact('Streak', streakText),
        fact('Last meeting', lastText)
    ];
    // Fixed order, and the depth count says how many of them the height affords.
    const extras = {
        longest: () => {
            if (!detail.longest) return fact('Longest run', 'None');
            const span = runSpanText(detail.longest);
            return fact('Longest run',
                `${detail.longest.count} straight by ${nameFor(detail.longest.side)}${span ? `, ${span}` : ''}`);
        },
        playoff: () => fact('Playoff meetings', detail.playoff.total
            ? `${detail.playoff.total} - ${meShort} ${detail.playoff.aWins}, ${oppShort} ${detail.playoff.bWins}`
            : 'None'),
        // "None", the same word every other fact uses for nothing to report. "Neither has won one" said the same thing in its own phrasing, which made the column of facts read as five separate voices rather than one.
        titles: () => fact('Titles', (titles.me || titles.opp)
            ? `${meShort} ${titles.me}, ${oppShort} ${titles.opp}`
            : 'None')
    };
    // Every one of them, always. The list is the display order, not a budget.
    RIVALRY_CARD_SECTIONS.forEach(key => rows.push(extras[key]()));
    return rows.join('');
}

function rivalryCardHtml(detail, meName, oppName, titles, shorts) {
    const t = detail.total;
    const played = t.w + t.l + t.t;
    if (!played) {
        // Two states, not one. A pair with postseason meetings and no regular-season ones has met - the record just does not count those games, and saying they never played would be false.
        const line = detail.playoff.total
            ? `These two have only met in the playoffs: ${detail.playoff.total}, ${escapeHtml((shorts && shorts.me) || meName)} ${detail.playoff.aWins}, ${escapeHtml((shorts && shorts.opp) || oppName)} ${detail.playoff.bWins}.`
            : 'These two have never played each other.';
        return `<div class="lh-riv-card">
                    <div class="lh-riv-opp">${escapeHtml(oppName)}</div>
                    <div class="lh-riv-empty">${line}</div>
                </div>`;
    }
    const mine = recordText(t.w, t.l, t.t);
    const theirs = recordText(t.l, t.w, t.t);
    const lead = t.w === t.l
        ? `Level at ${mine}`
        : `${escapeHtml(t.w > t.l ? meName : oppName)} leads ${t.w > t.l ? mine : theirs}`;
    // One bar per season, which is what the season pills used to make the reader ask for one year at a time. Same segment language as the list rows, so the two columns read as one picture.
    const seasons = detail.seasons.map(s => {
        const seg = (cls, n) => (n > 0 ? `<span class="${cls}" style="flex-grow:${n}"></span>` : '');
        return `<div class="lh-riv-season">
                    <span class="lh-riv-year">${s.year}</span>
                    <div class="lh-h2h-track">${seg('lh-h2h-win', s.w)}${seg('lh-h2h-tie', s.t)}${seg('lh-h2h-loss', s.l)}</div>
                    <span class="lh-h2h-rec">${recordText(s.w, s.l, s.t)}</span>
                </div>`;
    }).join('');
    return `<div class="lh-riv-card">
                <div class="lh-riv-opp">${escapeHtml(oppName)}</div>
                <div class="lh-riv-lead">${lead}</div>
                <div class="lh-riv-seasons" style="--lh-riv-season-rows:${Math.max(1, detail.seasons.length)}">${seasons}</div>
                <div class="lh-riv-facts">${rivalryFactsHtml(detail, (shorts && shorts.me) || meName, (shorts && shorts.opp) || oppName, titles)}</div>
            </div>`;
}

function gridHtml(pairs, franchises, countedYears, records) {
    if (!countedYears.length) {
        return `<div class="lh-block">
                    <div class="lh-block-head">Head to head</div>
                    <div class="lh-note">No season in this league played head-to-head matchups.</div>
                </div>`;
    }
    const byPair = new Map(pairs.map(p => [`${p.a}|${p.b}`, p]));
    // ONE franchise at a time, in the category pager's arrow language. The grid this replaces was a square, and a square of franchises grows as the square of the league: 6 teams is 36 cells and 20 teams is 400. Measured at 1280x800 with 20 teams staged, the grid needed 2194x418 in a 522x155 box, so 263px of vertical scroll and 1672px of sideways. A row is what anyone actually reads off a head-to-head grid anyway. Nobody scans 400 cells, they look up one franchise and see who owns them. OPENS ON THE OWNER'S FRANCHISE, by SWID, the way Team Metrics and My Team already do. null means nobody has stepped the pager yet, which is what separates "not chosen" from "chose the first one" - once the reader steps it, their choice holds.
    if (state.gridRow === null) state.gridRow = defaultFranchiseIndex(franchises, AppState.userSwid);
    const idx = Math.min(Math.max(state.gridRow | 0, 0), Math.max(0, franchises.length - 1));
    const me = franchises[idx];
    const rowFor = (opp) => {
        const [x, y] = me.key < opp.key ? [me.key, opp.key] : [opp.key, me.key];
        const rec = byPair.get(`${x}|${y}`);
        if (!rec) return null;
        const w = me.key === rec.a ? rec.aWins : rec.bWins;
        const l = me.key === rec.a ? rec.bWins : rec.aWins;
        return { w, l, t: rec.ties || 0, postseason: rec.postseason || 0 };
    };
    // NEVER-MET ROWS LAST. They carry no bar and no record, so a muted row sitting between two real rivalries breaks the column the eye is reading down. Met opponents keep the order they already had among themselves - a stable partition, not a re-sort.
    const allOpponents = franchises.filter(f => f.key !== me.key);
    const opponents = [
        ...allOpponents.filter(f => rowFor(f)),
        ...allOpponents.filter(f => !rowFor(f))
    ];
    // Selection SURVIVES a pane switch and a data refresh, because it lives in state rather than in the markup. It falls back to the first opponent only when the selected one is not on this list - which is what stepping to another franchise does, since nobody is their own opponent.
    const selected = opponents.some(o => o.key === state.rivalKey) ? state.rivalKey : (opponents[0] || {}).key;
    state.rivalKey = selected || null;
    const opp = opponents.find(o => o.key === selected) || null;

    const detail = opp ? rivalryDetail(state.seasons, state.payloads, me.key, opp.key) : null;
    const titleOf = (key) => (records.rows.find(r => r.key === key) || {}).titles || 0;
    const listFraction = rivalrySplit(opponents.length);

    const total = opponents.map(rowFor).filter(Boolean)
        .reduce((acc, r) => ({ w: acc.w + r.w, l: acc.l + r.l, t: acc.t + r.t }), { w: 0, l: 0, t: 0 });
    // The owner's own sentence, with both year lists computed.
    const note = coverageSentence(countedYears, state.seasons.map(s => s.year));

    // No block heading. The focus pill above already reads "Head to Head", and with the season pills gone the only thing left on that row was the same words twice - a row of height the two columns can use instead (recorded under DECISIONS-NEEDED in the entry).
    return `<div class="lh-block">
                <div class="lh-h2h-pager">
                    <button type="button" class="chrome-arrow lh-h2h-prev" aria-label="Previous franchise">&#8249;</button>
                    <div class="lh-h2h-name">${escapeHtml(me.name)}</div>
                    <button type="button" class="chrome-arrow lh-h2h-next" aria-label="Next franchise">&#8250;</button>
                </div>
                <div class="lh-h2h-total">${recordText(total.w, total.l, total.t)} against the league</div>
                ${note ? `<div class="lh-note">${escapeHtml(note)}</div>` : ''}
                <div class="lh-rivalry" style="--lh-riv-list:${listFraction.toFixed(3)}">
                    <div class="lh-rivalry-list" style="--lh-riv-rows:${Math.max(1, opponents.length)}">
                        ${rivalryRowsHtml(opponents, rowFor, selected)}
                    </div>
                    ${detail && opp
                        ? rivalryCardHtml(detail, me.name, opp.name, { me: titleOf(me.key), opp: titleOf(opp.key) },
                            { me: me.abbrev || me.name, opp: opp.abbrev || opp.name })
                        : '<div class="lh-riv-card"><div class="lh-riv-empty">This franchise has no opponents on record.</div></div>'}
                </div>
            </div>`;
}

// Tier 2 (M3). The union of every category ever scored, each column saying how much of the league's life it covers. Marks rather than words: the cell answers one yes-or-no question, and 16 columns of the word "Scored" reads as a wall of text where a column of ticks reads at a glance. The cross is the quiet colour, not the danger one - a category a season did not score is a fact about the league's history, not a fault.
function categoryTableHtml(union, seasons) {
    if (!union.stats.length) return '';
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const byYear = new Map(seasons.map(s => [s.year, new Set(s.statIds)]));
    const years = [...union.years].sort((a, b) => b - a);
    // No coverage count under the name and no caption over the table. Both said what the column of marks already says: the reader can see which seasons scored it by looking down the column, and "2 of 3" was the same fact counted for them. The career table keeps its coverage notes, because that one has no marks to read them off.
    const head = union.stats.map(s => `<th>${escapeHtml(map[s.statId] || s.statId)}</th>`).join('');
    // The season's FORMAT beside its year. A row of ticks means something different in a roto season than in a head-to-head one, and the reader had no way to tell which they were looking at without going back to the rail.
    const formatOf = new Map(seasons.map(s => [s.year, s.format]));
    const formatLabel = (f) => (f === 'roto' ? 'Roto' : (f === 'points' ? 'Points' : 'Head to Head Categories'));
    const body = years.map(year => {
        const scored = byYear.get(year) || new Set();
        const format = formatOf.get(year);
        const cells = union.stats.map(s => scored.has(s.statId)
            ? '<td class="lh-scored" title="Scored">✓</td>'
            : '<td class="lh-blank" title="Not scored">✕</td>').join('');
        return `<tr><th>${year}</th><td class="lh-format"><span class="lh-format-badge lh-format-${escapeHtml(format || 'cats')}">${escapeHtml(formatLabel(format))}</span></td>${cells}</tr>`;
    }).join('');
    // The row pitch comes from the season count, not from the table being told to be tall. categoryRowHeight is pure and tested; all this does is hand the answer to CSS.
    const rowH = categoryRowHeight(years.length);
    return `<div class="lh-block">
                <div class="lh-block-head">Categories by season</div>
                <div class="lh-scroll">
                    <table class="lh-table lh-grid lh-cats" style="--lh-cats-row-h:${rowH}px"><thead><tr><th></th><th>Format</th>${head}</tr></thead><tbody>${body}</tbody></table>
                </div>
            </div>`;
}

// Careers (M4). The only part of this tab that costs a player pool per season, so it is the only part that waits to be asked for. Everything above renders from league payloads already fetched. EVERY season counts, including the one being played (owner, item 2, reversing M4). M4 left the live season out because a career total that changes every week means something different every time it is read. The owner overrode it: the data is in hand and a career should read current. So these totals DO move during a season, by design, and the block says so rather than looking like a settled number that quietly is not one.
function careerYears() {
    return state.seasons.map(s => s.year).sort((a, b) => a - b);
}

// The season still being PLAYED, which is not the same as the newest one. A finished league's newest season is finished too, and saying its careers keep moving was wrong on every league the owner opened. Newest-and-unfinished, or nothing.
function liveYear() {
    const newest = state.seasons.reduce((best, s) => (!best || s.year > best.year ? s : best), null);
    return newest && !newest.finished ? newest.year : null;
}

// IS ANYTHING STILL ARRIVING FOR THIS PANE? The spinner's whole contract, and the ONE place to change when the careers harvest is rescheduled. Stated POSITIVELY - something is in flight - rather than as "not finished yet", and that is the point rather than a style preference. The negative form treats every non-terminal status as busy, so a resting state strands the spinner forever. There is already one such state: `idle`, which is what a pane holds before its first fetch and what it returns to on reset. The harvest is also about to be rescheduled (per-season on demand is the likely shape), and that will add more resting states - "two seasons loaded, nothing running, the rest on request" is exactly the shape a negative test gets wrong. Deliberately reads STATUS and the outstanding count only. It does not look at `phase`, which names the harvest's own stages, so a redesign that renames or removes those cannot reach this.
function careersBusy(c) {
    if (!c) return false;
    // Pools in flight. Everything else - idle, done, error - is at rest as far as pools go.
    if (c.status === 'loading') return true;
    // Attribution still landing behind a table that is already readable.
    return (c.refining || 0) > 0;
}

function careerBlockHtml() {
    const years = careerYears();
    if (!years.length) {
        return `<div class="lh-block">
                    <div class="lh-block-head">Player careers</div>
                    <div class="lh-note">No season of this league could be read.</div>
                </div>`;
    }
    // No open and no closed. Careers is a PANE now, so being on it is the whole of asking for it, and the caret toggle that used to gate it is gone with the band budget it belonged to. The lazy fetch survives the change: entering the pane is what pays for the pools, and every other pane renders from payloads already in hand.
    const c = state.careers;
    const live = liveYear();

    // ONE BUSY FLAG FOR EVERYTHING STILL ARRIVING. Two different things used to announce themselves in prose - a "Loading players X of Y" counter while the pools came in, and a sentence about the transaction log while attribution refined behind an already-drawn table. Both are the same fact from the reader's side: something is still landing. So both become one moving indicator in the corner, and neither gets a sentence. The table STAYS ON SCREEN while the log lands, which is item 2 and still the point: the spinner says the pane is not finished, and the rows are readable while it says so.
    const busy = careersBusy(c);

    // The coverage line becomes a lead-in and a row of year chips. The sentence used to end "...is still being played, so these totals keep moving", which the live dot now says without a clause - and said it in prose on every read, which is the kind of sentence VOICE deletes once a mark can carry it.
    const lead = `Totals over ${years.length} ${years.length === 1 ? 'season' : 'seasons'}`;
    const deferred = new Set(c.deferred || []);
    const chips = years.map(y => {
        const isLive = live !== null && y === live;
        // A DEFERRED season's transaction log was never requested: its franchises come from the draft, and its chip is the affordance that requests the rest. A button rather than a span, because it does something now.
        if (deferred.has(y)) {
            return `<button type="button" class="lh-season-chip is-deferred" data-log-year="${y}"`
                + ` title="Franchises are from the draft. Load the season's full history.">`
                + `${escapeHtml(String(y))}</button>`;
        }
        // The title is the only place the words survive, because a dot alone cannot say WHY it is there to someone meeting it for the first time.
        return `<span class="lh-season-chip${isLive ? ' is-live' : ''}"${isLive ? ' title="Still being played"' : ''}>`
            + (isLive ? '<span class="lh-live-dot" aria-hidden="true"></span>' : '')
            + `${escapeHtml(String(y))}</span>`;
    }).join('');

    let inner = '';
    if (c.status === 'error') {
        inner = `<div class="player-loading">No season's players could be read.</div>`;
    } else if (c.status === 'done') {
        inner = careerTableHtml(c.rows, years);
    }

    // aria-label rather than nothing: taking the counter out of the page took it away from a screen reader too, and a bare spinning box announces as an empty element. The label keeps the fact without the number, which is the same trade the visual makes.
    return `<div class="lh-block lh-block-fill lh-careers">
                ${busy ? '<span class="lh-spinner" role="status" aria-label="Loading players"></span>' : ''}
                <div class="lh-careers-head">
                    <span class="lh-note lh-careers-lead">${escapeHtml(lead)}</span>
                    <span class="lh-season-chips">${chips}</span>
                </div>
                ${inner}
            </div>`;
}

function careerGroupHtml(label, rows, statIds, groupKey, union, years) {
    if (!rows.length) return '';
    const sport = AppState.loadedSport;
    const map = ESPN_STAT_MAPS[sport] || {};
    const rateSet = AVERAGE_STATS[sport] || new Set();
    const specs = RATE_COMPONENTS[sport] || [];
    const nameByKey = new Map(state.franchises.map(f => [f.key, f.name]));
    const coverageOf = new Map(union.stats.map(s => [s.statId, s.coverage]));

    // The leaderboard's sort language, arrows and all, because this is the second sortable table in the app and a reader should not have to learn a second one.
    const sort = state.careerSort[groupKey] || defaultSort();
    const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
    const th = (key, text, extra = '') =>
        `<th class="sortable" data-career-sort="${key}" data-career-group="${groupKey}">${text}${arrow(key)}${extra}</th>`;

    const head = statIds.map(statId => {
        const text = escapeHtml(map[statId] || statId);
        const coverage = coverageOf.get(statId);
        const cover = coverage === union.totalSeasons
            ? ''
            : `<span class="lh-cover">${coverage} of ${union.totalSeasons}</span>`;
        return th(statId, text, cover);
    }).join('');

    const body = sortCareers(rows, { key: sort.key, dir: sort.dir, rateSpecs: specs }).map(row => {
        // A COUNT with the names on hover. The names themselves were the widest column in the table for a fact most rows answer with "one", and a player who has been round the league four times is the interesting case - which is what a number says at a glance.
        const names = row.franchiseKeys.map(k => nameByKey.get(k) || 'Unknown');
        // One franchise per line, which the hint layer renders because it sets white-space: pre-line.
        const hint = names.length ? names.join(HINT_BREAK) : 'Never rostered';
        const cells = statIds.map(statId => {
            const v = careerValue(row, statId, specs);
            // Blank, not zero, for a stat he has no components for. The same rule the category table follows, for the same reason.
            if (v === null || v === undefined || !Number.isFinite(Number(v))) return '<td class="lh-blank"></td>';
            const text = rateSet.has(statId) ? Number(v).toFixed(3) : String(Math.round(Number(v)));
            return `<td>${escapeHtml(text)}</td>`;
        }).join('');
        return `<tr>
                    <th class="lh-name">${escapeHtml(row.name)}</th>
                    <td>${row.seasons.length}</td>
                    <td class="lh-franchise-count" data-hint="${escapeHtml(hint)}">${names.length}</td>
                    ${cells}
                </tr>`;
    }).join('');

    return `<div class="lh-career-group">
                <div class="lh-scroll">
                    <table class="lh-table lh-grid lh-careers">
                        <thead><tr>${th('name', 'Player')}${th('seasons', 'Seasons')}<th>Franchises</th>${head}</tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            </div>`;
}

function careerTableHtml(rows, years) {
    if (!rows.length) return '<div class="player-loading">No player has been rostered in this league.</div>';
    const sport = AppState.loadedSport;
    const union = categoryUnion(state.seasons.filter(s => years.includes(s.year)));
    const byRole = splitStatIdsByRole(sport, union.stats.map(s => s.statId));
    // Decoded here, with the leaderboard's own function, so a career row is grouped by exactly the rule the rest of the app groups by rather than by a second one that drifts.
    const slotMap = SLOT_POSITION_MAPS[sport];
    const posMap = POSITION_MAPS[sport] || {};
    const positionsOf = (row) => {
        const decoded = slotMap && Array.isArray(row.eligibleSlots)
            ? computeEligiblePositions(row.eligibleSlots, slotMap)
            : [];
        if (decoded.length) return decoded;
        const fallback = posMap[row.defaultPositionId];
        return fallback ? [fallback] : [];
    };
    const groups = rows.reduce((acc, row) => {
        const role = playerRoleGroups({ eligiblePositions: positionsOf(row) }, sport);
        if (role.primary) acc.primary.push(row);
        if (role.secondary) acc.secondary.push(row);
        // Eligibility can be missing for a player the pool no longer carries a position for. He is not dropped - he goes with the outfield players, whose columns are the counting stats every sport shares.
        if (!role.primary && !role.secondary) acc.primary.push(row);
        return acc;
    }, { primary: [], secondary: [] });

    // ONE GROUP AT A TIME behind pills, which is My Team's Categories/Schedule face pattern reused rather than re-invented - same interaction, same chrome, same classes. Stacked, the two tables split a band that was already the shortest thing on the tab and neither got enough rows to be worth scrolling. One of them at full height is a table you can actually read, and the pill carries the count so the other group is never hidden, only closed.
    const labels = sport === 'fhl' ? { primary: 'Skaters', secondary: 'Goalies' } : { primary: 'Batters', secondary: 'Pitchers' };
    const present = ['primary', 'secondary'].filter(g => groups[g].length);
    if (!present.length) return '<div class="player-loading">No player has been rostered in this league.</div>';
    const active = present.includes(state.careerGroup) ? state.careerGroup : present[0];
    const pills = present.map(g =>
        `<button type="button" class="mt-view-tab${g === active ? ' active' : ''}" data-career-group-pill="${g}">${escapeHtml(labels[g])} - ${groups[g].length}</button>`
    ).join('');
    const table = careerGroupHtml(labels[active], groups[active], byRole[active], active, union, years);
    return `<div class="mt-view-tabs lh-role-tabs">${pills}</div>${table}`;
}

// Fetches the pools the first time the careers pane is entered, and never again. A pane the reader keeps flipping back to costs one fetch, not one per visit; an error is the one state worth retrying, since a failed season is exactly what somebody would come back to try again.
async function ensureCareers(container, key) {
    const years = careerYears();
    if (!years.length) return;
    if (state.careers.status === 'loading' || state.careers.status === 'done') return;
    // 'error' is TERMINAL for this auto-trigger: attribute() can publish an error status while the ownership walk is still in flight (every pool failing is enough), and render() calls back in here on every repaint - so 'error' passing this guard launched a CONCURRENT full walk per render, measured at 56,408 transaction requests in one staged pane before it was killed. The avalanche predates (the guard has admitted 'error' since ); a runaway-request bug is this entry's to fix. Retry is the pane switch: leaving and re-entering careers resets the status to idle below.
    if (state.careers.status === 'error') return;

    state.careers = { status: 'loading', rows: [], loaded: 0, total: years.length, years, phase: 'pools' };
    render(container);

    const pools = await loadHistoryPools(AppState.loadedSport, AppState.apiData.id, years, (done, total) => {
        if (state.key !== key || state.careers.status !== 'loading') return;
        state.careers.loaded = done;
        state.careers.total = total;
        render(container);
    });
    if (state.key !== key) return;

    const seasonsByYear = {};
    state.seasons.forEach(s => { seasonsByYear[s.year] = s; });

    // Rebuilt from the pools already in hand every time attribution improves. buildCareers is pure and the pools are cached, so this is arithmetic over data in memory - no refetch, and the sort, the pills and the scroll position all come back the same way they would on any render. The owners map and the deferred list ride on state so a later per-season load (the chip click below) can merge into what is already attributed instead of starting over.
    const attribute = (owners, refining) => {
        if (state.key !== key) return;
        const rows = buildCareers(pools, seasonsByYear, owners);
        const status = rows.length || Object.keys(pools).length ? 'done' : 'error';
        state.careers = {
            status, rows, loaded: years.length, total: years.length, years, phase: 'done', refining,
            deferred: state.careers.deferred || [], logYears: state.careers.logYears, owners
        };
        render(container);
    };

    // WHO HELD EACH PLAYER, draft-first, and now WALKED ON DEMAND: the full transaction log is requested for the TWO most recent seasons only - the live one usually rides the Roto Race harvest free, so the common click costs one season's walk - and every older season renders on draft attribution with its chip offering the rest. Measured before the split: six seasons cost 1,179 requests on one click.
    const live = AppState.rosterTransactionData && AppState.apiData
        ? { year: AppState.apiData.seasonId, picks: AppState.rosterTransactionData.picks, transactions: AppState.rosterTransactionData.transactions }
        : null;
    if (!state.careers.logYears) state.careers.logYears = years.slice(-2);
    let outstanding = 0;
    const owners = await loadHistoryOwnership(AppState.loadedSport, AppState.apiData.id, years, state.payloads, {
        liveSeason: live,
        fullLogYears: state.careers.logYears,
        // The loader says which seasons still owe a transaction log, so the note counts the real remainder rather than assuming every season needs one - a cached season, or the live one the Roto Race already harvested, is finished before this fires. Deferred seasons are a third state: not owed, OFFERED.
        onDrafts: (draftOwners, walkingYears, deferredYears) => {
            outstanding = walkingYears.length;
            state.careers.deferred = deferredYears;
            attribute(draftOwners, outstanding);
        },
        onSeason: (year, soFar) => {
            outstanding = Math.max(0, outstanding - 1);
            attribute(soFar, outstanding);
        }
    });
    if (state.key !== key) return;
    attribute(owners, outstanding);
}

// One deferred season's full log, requested by its chip. The walk costs ~194 requests for that season alone; on completion its attribution merges into the table in place, exactly as a phase-2 season lands during the first load. Guarded so a double-click cannot start two walks.
const logLoadsInFlight = new Set();
async function loadDeferredSeasonLog(container, key, year) {
    const c = state.careers;
    if (!c || c.status !== 'done' || logLoadsInFlight.has(year)) return;
    if (!(c.deferred || []).includes(year)) return;
    logLoadsInFlight.add(year);
    c.deferred = c.deferred.filter(y => y !== year);
    c.logYears = [...(c.logYears || []), year];
    c.refining = (c.refining || 0) + 1;
    render(container);
    try {
        const live = AppState.rosterTransactionData && AppState.apiData
            ? { year: AppState.apiData.seasonId, picks: AppState.rosterTransactionData.picks, transactions: AppState.rosterTransactionData.transactions }
            : null;
        const result = await loadHistoryOwnership(AppState.loadedSport, AppState.apiData.id, [year], state.payloads, {
            liveSeason: live, fullLogYears: [year]
        });
        if (state.key !== key) return;
        const merged = { ...(state.careers.owners || {}), ...result };
        const seasonsByYear = {};
        state.seasons.forEach(s => { seasonsByYear[s.year] = s; });
        const pools = {};
        // The pools were fetched by ensureCareers and are session-cached; re-asking is free.
        const freshPools = await loadHistoryPools(AppState.loadedSport, AppState.apiData.id, state.careers.years, () => {});
        Object.assign(pools, freshPools);
        if (state.key !== key) return;
        const rows = buildCareers(pools, seasonsByYear, merged);
        state.careers = {
            ...state.careers, rows, owners: merged,
            refining: Math.max(0, (state.careers.refining || 1) - 1)
        };
        render(container);
    } finally {
        logLoadsInFlight.delete(year);
    }
}

function render(container) {
    if (state.status === 'loading') {
        container.innerHTML = `<div class="player-loading">Loading seasons ${state.loaded} of ${state.total}</div>`;
        return;
    }
    if (state.status === 'error') {
        container.innerHTML = '<div class="player-loading">No past seasons could be read for this league.</div>';
        return;
    }
    if (!state.seasons.length) {
        container.innerHTML = '<div class="player-loading">This league has one season, so there is no history yet.</div>';
        return;
    }
    const nameByKey = new Map(state.franchises.map(f => [f.key, f.name]));
    const nameOf = (key) => nameByKey.get(key) || 'Unknown';
    const records = allTimeRecords(state.seasons);
    const union = categoryUnion(state.seasons);
    const total = state.seasons.length;

    // Every season, always. The one-season view the pills used to offer is gone with them - the rivalry card carries a bar per season, so a year is something the reader reads rather than something they have to ask for first.
    const pairs = headToHead(state.seasons, state.payloads);
    const gridFranchises = state.franchises;

    // THREE ZONES. The rail is the champions, the standings sit at the top of the main area and are always visible, and the focus pane takes ALL the remaining height, always. There is no open or closed state anywhere on this tab any more, which is how the grey space dies: the budget of caps and floors this replaces could always be defeated by some combination of league size and what the reader had collapsed, because it was arithmetic over a variable number of bands. One pane that owns the leftover cannot be.
    const panes = [
        { key: 'h2h', label: 'Head to Head' },
        { key: 'categories', label: 'Categories' },
        { key: 'careers', label: 'Player Careers' }
    ];
    const activePane = panes.some(p => p.key === state.focusPane) ? state.focusPane : 'h2h';
    const pills = panes.map(p =>
        `<button type="button" class="mt-view-tab${p.key === activePane ? ' active' : ''}" data-focus-pane="${p.key}">${escapeHtml(p.label)}</button>`
    ).join('');
    const paneBody = activePane === 'h2h'
        ? gridHtml(pairs, gridFranchises, records.countedYears, records)
        : (activePane === 'categories' ? categoryTableHtml(union, state.seasons) : careerBlockHtml());

    container.innerHTML = `
        <div class="lh-layout">
            <aside class="lh-rail" data-sport="${escapeHtml(AppState.loadedSport || '')}">${railHtml(state.seasons, nameOf)}</aside>
            <div class="lh-main">
                ${standingsHtml(records, total)}
                <div class="lh-focus">
                    <div class="mt-view-tabs lh-focus-tabs">${pills}</div>
                    <div class="lh-focus-pane">${paneBody}</div>
                </div>
            </div>
        </div>`;

    // The franchise counts carry their names on hover, through the app's shared hint layer.
    attachDataTooltips(container);

    // The pennant logos are avatar images too, so they take the same wiring the rosters use: one that removes an image which fails rather than leaving a broken glyph over the monogram, and one that counts the request for the diagnostic panel's tally. Before this they were the only <img> in the app nobody wired, so a dead ESPN URL had no fallback and no count.
    wirePlayerAvatars(container);

    // The champion's colour, painted in after the fact. Deliberately not awaited: the wall is complete and readable the moment it renders, and the dye is an improvement that arrives when the images do. A rejection here can only mean a logo that could not be sampled, which the ladder already treats as ordinary.
    dyeChampionFlags(container);

    // Opening the careers pane is what pays for the pools, exactly as opening the old block did. Every other pane renders from payloads already in hand, so the fetch still happens only when somebody asks for careers and never on the way past.
    container.querySelectorAll('[data-focus-pane]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.focusPane = btn.dataset.focusPane;
            // An explicit re-entry is the one sanctioned retry after an error: the render path treats 'error' as terminal, so without this reset a failed careers load could never be retried at all.
            if (state.focusPane === 'careers' && state.careers.status === 'error') state.careers = emptyCareers();
            render(container);
            if (state.focusPane === 'careers') ensureCareers(container, state.key);
        });
    });
    if (activePane === 'careers') ensureCareers(container, state.key);

    // A NEW column opens descending, and clicking it again flips - the leaderboard's rule. The one departure is a lower-is-better category, which opens ascending so the first click puts the best career at the top rather than the worst. Player opens A to Z for the same reason. The leaderboard does NOT do this: it opens every column descending, so sorting it by ERA leads with the worst. That is a real inconsistency between two sortable tables and it needs an owner ruling rather than a quiet second convention, so it is filed rather than copied.
    const inverse = INVERSE_STATS[AppState.loadedSport] || new Set();
    // The pills only change which table is drawn. careerSort is keyed by group and is not touched here, which is what makes a sort survive switching away and back.
    container.querySelectorAll('[data-career-group-pill]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.careerGroup = btn.dataset.careerGroupPill;
            render(container);
        });
    });

    container.querySelectorAll('[data-career-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.careerSort;
            const group = th.dataset.careerGroup;
            const current = state.careerSort[group] || defaultSort();
            state.careerSort[group] = current.key === key
                ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
                : { key, dir: key === 'name' ? 'asc' : openingSortDir(key, inverse) };
            render(container);
        });
    });

    // Selecting an opponent is the pane's one interaction, and it is a row rather than a control, so it answers the keyboard the same way the season flags do.
    container.querySelectorAll('[data-rival]').forEach(row => {
        const pick = () => {
            state.rivalKey = row.dataset.rival;
            render(container);
        };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });
    });

    // Wraps at both ends, the way the category pager does, so neither arrow ever needs a disabled state and the last franchise is one click from the first.
    const stepRow = (delta) => {
        const n = gridFranchises.length || 1;
        state.gridRow = ((state.gridRow + delta) % n + n) % n;
        render(container);
    };
    container.querySelector('.lh-h2h-next')?.addEventListener('click', () => stepRow(1));
    container.querySelector('.lh-h2h-prev')?.addEventListener('click', () => stepRow(-1));

    // A deferred season's chip requests its own transaction log. stopPropagation so the click stays a data request and never doubles as anything a parent might listen for.
    container.querySelectorAll('.lh-season-chip.is-deferred').forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            loadDeferredSeasonLog(container, state.key, Number(chip.dataset.logYear));
        });
    });

    container.querySelectorAll('.lh-season-row').forEach(row => {
        const go = () => {
            const year = row.dataset.year;
            const select = document.getElementById('year');
            if (select && [...select.options].some(o => o.value === year)) {
                select.value = year;
                document.getElementById('fetch-btn')?.click();
            }
        };
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
}

export async function renderHistoryTab() {
    const container = document.getElementById('history-container');
    if (!container) return;
    if (!AppState.apiData) {
        container.innerHTML = '<div class="player-loading">Fetch your league data on the Team Metrics tab first.</div>';
        return;
    }
    const sport = AppState.loadedSport;
    const leagueId = AppState.apiData.id;
    const key = `${sport}:${leagueId}`;

    if (state.key === key && state.status === 'done') { render(container); return; }
    if (state.key === key && state.status === 'loading') { render(container); return; }

    // NEVER anchored to the loaded year. What the dashboard is showing has nothing to do with how long the league has existed.
    const years = leagueSeasonYears(AppState.leagueHistoryYears, AppState.apiData.seasonId, new Date().getFullYear());

    state = { key, status: 'loading', seasons: [], payloads: {}, franchises: [], loaded: 0, total: years.length, gridRow: null, rivalKey: null, careerSort: defaultSorts(), careerGroup: 'primary', focusPane: 'h2h', careers: emptyCareers() };
    render(container);

    const payloads = await loadHistorySeasons(sport, leagueId, years, (done, total) => {
        if (state.key !== key) return;
        state.loaded = done;
        state.total = total;
        render(container);
    });
    if (state.key !== key) return;

    // The season already in memory never needs refetching, and using it also means the current season is present even when its own fetch would have been refused.
    payloads[AppState.apiData.seasonId] = payloads[AppState.apiData.seasonId] || AppState.apiData;

    const seasons = Object.values(payloads).map(summarizeSeason).filter(Boolean);
    state.payloads = payloads;
    state.seasons = seasons;
    state.franchises = buildFranchises(seasons);
    state.status = seasons.length ? 'done' : 'error';
    render(container);
}
