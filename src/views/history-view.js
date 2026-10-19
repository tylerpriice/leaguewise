/**
 * League History's rendering: the pennant rail of champions, the all-time standings, the season
 * card and a focus pane for head-to-head records, categories and player careers.
 *
 * The math lives in the engines' history module and stays pure. This file only turns its output
 * into markup and owns the loading state. History is a top-level tab rather than a band above the
 * tabs, so no other view loses vertical space to it. What a roto season cannot answer is stated,
 * not left blank.
 * @module history-view
 */
import { AppState, ESPN_STAT_MAPS, AVERAGE_STATS, RATE_COMPONENTS, leagueInverseIds, POSITION_MAPS, SLOT_POSITION_MAPS } from '../data/state.js';
import { escapeHtml, openingSortDir, registerLeagueView, splitStatIdsByRole, attachDataTooltips, leagueSeasonYears, seasonsSeenFor } from './utils.js';
import { playerRoleGroups, computeEligiblePositions, liveHarvestInFlight } from './players.js';
import { buildTeamLogoHtml, buildPlayerAvatarHtml, wirePlayerAvatars } from './images.js';
import { sampleLogoColour, darkenUntilContrast, toCssRgb, parseCssColour, contrastRatio } from './logo-colour.js';
import { loadHistorySeasons, loadHistoryPools, loadHistoryOwnership } from '../data/api.js';
import {
    summarizeSeason, buildFranchises, allTimeRecords, headToHead, categoryUnion,
    buildCareers, careerValue, sortCareers, categoryRowHeight,
    rivalryDetail, rivalrySplit, RIVALRY_CARD_SECTIONS,
    recordText, defaultFranchiseIndex, coverageSentence, runSpanText, pennantLines, franchiseKeyOf,
    seasonSummary, seasonCategoryLeaders, rotoSeasonTable
} from '../engines/history.js';
import { rotoPointsForCategory } from '../engines/rank-engine.js';
import { matchupTally, matchupPoints } from './utils.js';

// The line break used to join a list of names into a multi-line hover hint.
const HINT_BREAK = String.fromCharCode(10);

// Nicknames follow the franchise, not the team id, because a team id is not stable across seasons. The map is built from the loaded season's own teams, the only ones a nickname can be set on.
function nicknamesByFranchiseKey() {
    const map = new Map();
    (AppState.apiData?.teams || []).forEach(t => {
        const nick = AppState.nicknames.get(String(t.id));
        if (nick) map.set(franchiseKeyOf(t), nick);
    });
    return map;
}
const defaultSort = () => ({ key: null, dir: 'desc' });
// One sort per role group, since the two groups do not share columns.
const defaultSorts = () => ({ primary: defaultSort(), secondary: defaultSort() });
const emptyCareers = () => ({ status: 'idle', rows: [], loaded: 0, total: 0, years: [], phase: 'pools', refining: 0, deferred: [], refused: [], logYears: null, owners: {} });
let state = { key: null, status: 'idle', seasons: [], payloads: {}, franchises: [], loaded: 0, total: 0, gridRow: null, rivalKey: null, careerSort: defaultSorts(), careerGroup: 'primary', focusPane: 'h2h', focusYear: null, careers: emptyCareers() };

/**
 * Returns the History tab to its empty starting state, so a different league never shows the
 * previous league's franchises while its own seasons load.
 *
 * @returns {void}
 */
export function resetHistoryView() {
    state = { key: null, status: 'idle', seasons: [], payloads: {}, franchises: [], loaded: 0, total: 0, gridRow: null, rivalKey: null, careerSort: defaultSorts(), careerGroup: 'primary', focusPane: 'h2h', focusYear: null, careers: emptyCareers() };
}

// Registered here rather than called from the fetch path, so a league switch cannot forget this tab. History belongs to the league on screen, so a new league starts empty.
registerLeagueView('history', { reset: resetHistoryView });

// Stated once, wherever a number covers fewer seasons than the league has lived, instead of a footnote under a total that quietly means something else.
function coverageNote(countedYears, total) {
    if (!countedYears.length) return 'No season in this league kept a win-loss record.';
    if (countedYears.length === total) return '';
    return 'Roto leagues are not head to head so there is no W-L-T to track.';
}

// A raw float rounded to two places with trailing zeros trimmed. Margins arrive unrounded and the renderer formats them.
function fmtNum(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
    return String(Math.round(Number(v) * 100) / 100);
}

// The pennant rail. Each title is one shape down the left, drawn in the sport's own form, and a season with no champion hangs greyed so the wall has no gap where the year should be.

// The champion's colour is painted on the cloth after the rail is in the DOM, one custom property per flag, so the markup builder stays synchronous. Each sample is darkened until the gold type clears 4.5:1 against it, and one that cannot get there leaves the flag undyed.
const DYE_CONTRAST_FLOOR = 4.5;

// Third rung of the colour ladder, the team's own chart colour. It is matched through the same franchise key History tracks careers by, so a champion is found by franchise and not by a team id that may mean another team this season.
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

// The legend keeps the name whole or gives it up to the line under the flag. The type steps down a rung at a time to a floor, and a name that still does not fit hides the legend and shows the full name under the flag, so nothing is shown cut.
const LEGEND_RUNGS = [[12, 8], [11, 7.5], [10, 7], [9, 7]];
function fitPennantLegends(container) {
    container.querySelectorAll('.lh-rail:not([data-sport="fhl"]) .lh-flag').forEach(flag => {
        const loc = flag.querySelector('.lh-flag-loc');
        const nick = flag.querySelector('.lh-flag-nick');
        if (!loc || !nick || !nick.clientWidth) return;     // not laid out (a hidden tab): the next call measures
        flag.classList.remove('lh-flag-longname');
        const holds = () => nick.scrollWidth <= nick.clientWidth + 1 && loc.scrollWidth <= loc.clientWidth + 1;
        const fits = LEGEND_RUNGS.some(([nickPx, locPx]) => {
            flag.style.setProperty('--lh-nick-size', `${nickPx}px`);
            flag.style.setProperty('--lh-loc-size', `${locPx}px`);
            return holds();
        });
        if (!fits) {
            flag.style.removeProperty('--lh-nick-size');
            flag.style.removeProperty('--lh-loc-size');
            flag.classList.add('lh-flag-longname');
        }
    });
}

async function dyeChampionFlags(container) {
    // The wall is drawn the same in every style and a style only sets the cloth's colours, so the dye is fitted against whichever ink token the style names.
    const flags = [...container.querySelectorAll('.lh-flag[data-franchise]')];
    if (!flags.length) return;

    const gold = parseCssColour(getComputedStyle(document.documentElement).getPropertyValue('--lh-ink'));
    if (!gold) return;

    await Promise.all(flags.map(async (flag) => {
        // Tried in order: the logo's colour, then the team's chart colour, then nothing, which is a plain look and not a failure.
        const sampled = await sampleLogoColour(flag.dataset.logo)
            || chartColourForFranchise(flag.dataset.franchise);
        if (!sampled) {
            if (flag.isConnected) flag.classList.add('lh-flag-blank');
            return;
        }
        const fixed = darkenUntilContrast(sampled, gold, DYE_CONTRAST_FLOOR);
        // No version of this colour keeps the type readable, so the flag keeps the theme black.
        if (!fixed || !fixed.passed) return;
        // The element may have been re-rendered out from under the await; setting a property on a detached node is harmless but pointless, and skipping it keeps the intent obvious.
        if (!flag.isConnected) return;
        flag.style.setProperty('--flag-dye', toCssRgb(fixed.rgb));

        // The monogram needs its own darkening because its letters sit on the brass badge, not on the cloth. A dye that clears the gold can still fall well short against brass.
        const badge = flag.querySelector('.lh-flag-badge');
        const brass = badge && parseCssColour(getComputedStyle(badge).backgroundColor);
        if (!brass) return;
        const ink = darkenUntilContrast(sampled, brass, DYE_CONTRAST_FLOOR);
        // If the letters cannot be made legible on brass they keep the theme ink.
        if (ink && ink.passed) flag.style.setProperty('--flag-dye-ink', toCssRgb(ink.rgb));
    }));
}

function railHtml(seasons, nameOf, focusYear) {
    // The champion's franchise record supplies the badge. A past champion uses the logo from the season it won, already in hand, so the rail costs no fetch.
    const byKey = new Map(state.franchises.map(f => [f.key, f]));
    const shapes = [...seasons].sort((a, b) => b.year - a.year).map(season => {
        const decided = !!season.championKey;
        const champ = decided ? byKey.get(season.championKey) : null;
        const how = season.format === 'roto' ? 'Roto' : 'Playoffs';
        const tone = decided ? (season.format === 'roto' ? ' lh-flag-roto' : ' lh-flag-bracket') : ' lh-flag-open';
        // The pennant carries the season click and selects the year in place. The name is split the way a ballclub's pennant splits it, built for every style so a style change under a rendered rail needs no re-render.
        const champName = decided ? nameOf(season.championKey) : 'Not decided';
        const lines = pennantLines(champName);
        // The plate word is the format the title was won under.
        const plate = decided ? (season.format === 'roto' ? 'Roto' : 'Bracket') : 'Open';
        // The logo url and the franchise key both ride on the flag. The first is what gets sampled and the second is how the colour ladder finds the team's chart colour, so a champion with no logo still gets one.
        const dyeSrc = (champ && champ.logo ? ` data-logo="${escapeHtml(champ.logo)}"` : '')
            + (decided && season.championKey ? ` data-franchise="${escapeHtml(season.championKey)}"` : '');
        const selected = season.year === focusYear;
        return `<div class="lh-flag${tone}${selected ? ' lh-flag-selected' : ''} lh-season-row" data-focus-year="${season.year}" tabindex="0" role="button"${dyeSrc}
                     title="${escapeHtml(decided ? how : 'Not decided')} - click to view ${season.year}">
                    <div class="lh-flag-shape">${champ ? buildTeamLogoHtml(champ.name, champ.logo) : ''}<span class="lh-flag-legend"><span class="lh-flag-loc">${escapeHtml(lines.top)}</span><span class="lh-flag-nick">${escapeHtml(lines.nick)}</span><span class="lh-flag-raised">${season.year}</span></span></div>
                    <div class="lh-flag-year"><span class="lh-flag-plate-year">${season.year}</span><span class="lh-flag-how">${escapeHtml(plate)}</span></div>
                    <div class="lh-flag-name">${escapeHtml(champName)}</div>
                </div>`;
    }).join('');

    // The league's vitals close the rail. Careers are counted only once the pools are in, so before that the rail says what it knows and no more.
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
    const nicknames = nicknamesByFranchiseKey();
    const rows = records.rows.map(r => {
        const pct = r.winPct === null ? '-' : r.winPct.toFixed(3).replace(/^0/, '');
        const rec = r.recordSeasons ? recordText(r.wins, r.losses, r.ties) : '-';
        return `<tr>
                    <td class="lh-name"><div class="lh-name-wrap"><span class="lh-name-text">${escapeHtml(nicknames.get(r.key) || r.name)}</span><span class="lh-title-slot">${r.titles ? `<span class="lh-title-chip">&#128081; ${r.titles}</span>` : ''}</span></div></td>
                    <td class="lh-col-titles">${r.titles || ''}</td>
                    <td>${r.seasonsPlayed}</td>
                    <td>${rec}</td>
                    <td>${pct}</td>
                </tr>`;
    }).join('');
    return `<div class="lh-block">
                <div class="lh-block-head">All-time standings</div>
                ${note ? `<div class="lh-note">${escapeHtml(note)}</div>` : ''}
                <div class="lh-scroll">
                    <table class="lh-table${records.rows.some(r => r.titles) ? ' lh-has-crowns' : ''}">
                        <thead><tr><th>Franchise</th><th class="lh-col-titles">Titles</th><th>Seasons</th><th>W-L-T</th><th>Win%</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
}

// "All time" comes first, then every season descending, the order the rail hangs in, since the pennant and the strip select the same state. A season that could not be summarized still gets a chip and falls through to the season box's own message.
function yearStripHtml(seasons, focusYear) {
    const years = [...seasons].sort((a, b) => b.year - a.year).map(s => s.year);
    const chip = (year, label) => {
        const on = year === focusYear ? ' on' : '';
        return `<button type="button" class="lh-year-chip${on}" data-focus-year="${year === null ? '' : year}">${escapeHtml(label)}</button>`;
    };
    return `<div class="lh-year-strip">
                ${chip(null, 'All time')}
                ${years.map(y => chip(y, String(y))).join('')}
            </div>`;
}

// One season off the summary, drawn as one face per format. A fact the season does not have is not drawn, so the box never prints a placeholder. The caller computes `extras` once from the payload, since this renderer sees only the summary.
function seasonBoxHtml(summary, nameOf, extras = {}) {
    if (!summary) {
        return `<div class="lh-block lh-season-block">
                    <div class="lh-note">This season's payload could not be summarized.</div>
                </div>`;
    }
    const format = summary.format;
    const formatLabel = format === 'roto' ? 'Roto' : (format === 'points' ? 'Points' : 'Head to Head Categories');
    const unplayed = format !== 'roto' && !summary.podium.length;
    const ord = (n) => `${n}${n === 1 ? 'st' : (n === 2 ? 'nd' : (n === 3 ? 'rd' : 'th'))}`;
    const matchupNum = (when) => (when || '').replace(/^M/, '');
    // A `when` is one matchup ("M9") or a run ("M4-M13"): "matchup 9", "matchups 4 to 13".
    const matchupsText = (when) => {
        const nums = (when || '').replace(/M/g, '');
        return nums.includes('-') ? `matchups ${nums.replace('-', ' to ')}` : `matchup ${nums}`;
    };
    // A points season prints to one decimal, the standings' own precision; a category season's figures are counts.
    const pts = (v) => (Number.isFinite(Number(v)) ? (Math.round(Number(v) * 10) / 10).toFixed(1) : '');
    const fact = (label, value) => `<div class="lh-fact"><span>${escapeHtml(label)}</span><b>${value}</b></div>`;
    // A fact as parts: the team, the figure and the matchup, each in its own span with its separator, so the phone card can place the team under the label and the figure at the right while the desktop line reads exactly as it did (the spans and separators have no box there).
    const factParts = (label, name, sepA, fig, sepB, when) => fact(label,
        `${name ? `<span class="lh-fn">${name}</span>` : ''}${sepA ? `<span class="lh-sep">${sepA}</span>` : ''}`
        + `<span class="lh-fr">${fig ? `<span class="lh-ff">${fig}</span>` : ''}${sepB && when ? `<span class="lh-sep">${sepB}</span>` : ''}${when ? `<span class="lh-fw">${when}</span>` : ''}</span>`);
    const nm = (key) => escapeHtml(nameOf(key));
    const f = summary.facts || {};

    const headline = `${summary.year} · ${escapeHtml(summary.championName || 'Not decided')} · ${formatLabel}`;
    const openLink = `<button type="button" class="lh-open-year-link" data-open-year="${summary.year}">Open ${summary.year} in the dashboard ›</button>`;
    const wrap = (head, inner) => `<div class="lh-block lh-season-block">
                <div class="lh-block-head">${head}</div>
                <div class="lh-scroll">${inner}</div>
            </div>`;

    // A SEASON NOBODY HAS PLAYED is one short face: its format, its size and the count of matchups played.
    if (unplayed) {
        return wrap(`${summary.year} · ${formatLabel}`, `<div class="lh-season-grid lh-season-unplayed">
                        <div class="lh-facts">${fact('Teams', escapeHtml(summary.teams))}${fact('Matchups played', '0')}</div>
                        <div class="lh-podium">${openLink}</div>
                    </div>`);
    }

    const podiumHtml = summary.podium.map((p, i) => `
        <div class="lh-pod${i === 0 ? ' lh-pod-first' : ''}">
            <span class="lh-pod-n">${i + 1}</span>
            <span class="lh-pod-t">${escapeHtml(p.name)}<small>${escapeHtml(p.note)}</small></span>
            <span class="lh-pod-r">${p.record ? escapeHtml(p.record) : ''}${p.seed ? `<small>${ord(p.seed)} seed</small>` : ''}</span>
        </div>`).join('');
    const podiumCol = `<div class="lh-podium">${podiumHtml}${openLink}</div>`;

    // The champion's path is a head-to-head fact; a roto season has no bracket and draws none.
    const pathHtml = (summary.path && summary.path.length)
        ? `<div class="lh-season-label">The champion's path</div>
           <div class="lh-path">${summary.path.map(g => `<b>matchup ${g.round}</b> · ${escapeHtml(summary.championName || '')} <span class="${g.won === true ? 'lh-path-w' : (g.won === false ? 'lh-path-l' : '')}">${escapeHtml(g.score)}</span> ${escapeHtml(g.opponentName || '')}`).join('<br>')}</div>`
        : '';

    // A tie IS the closest matchup (history.js nulls f.closest whenever f.ties exists), and one tie is still plural-free. The two sides of a matchup fact, the winner first, or the winner alone where the engine gave no other side.
    const teamsLine = (g, joiner) => (g.against ? `${nm(g.key)}${joiner}${nm(g.against)}` : nm(g.key));
    const closestRow = (value) => {
        if (f.ties) {
            // The count leads in the text and sits in the figure column on a phone; the grid places each span, so the order here is the desktop's.
            return fact('Closest matchup', `<span class="lh-fr"><span class="lh-ff">${f.ties.count} tie${f.ties.count === 1 ? '' : 's'}</span></span><span class="lh-sep">: </span>`
                + `<span class="lh-fn">${f.ties.games.map(g => `${nm(g.keys[0])} v ${nm(g.keys[1])} (matchup ${matchupNum(g.when)})`).join(', ')}</span>`);
        }
        return f.closest ? factParts('Closest matchup', teamsLine(f.closest, ' v '), ' \u00b7 ', `margin ${value(f.closest.value)}`, ', ', matchupsText(f.closest.when)) : '';
    };
    const standRow = (cells, head) => `<div class="lh-stand2-row${head ? ' lh-stand2-head' : ''}" style="grid-template-columns:1fr ${cells.slice(1).map(() => 'auto').join(' ')};column-gap:12px">${cells.map(c => `<span>${c}</span>`).join('')}</div>`;
    const finishText = (r) => (r.finish ? ord(r.finish) : '');
    const standHtml = (headCells, rowCells) => `<div class="lh-season-label">Playoff results</div><div class="lh-stand2">${standRow(headCells, true)}${summary.standings.map(r => standRow(rowCells(r))).join('')}</div>`;

    // CATEGORY SEASON: the facts the format has, then who led each category (a sole leader named against it, a shared lead set apart).
    if (format === 'h2h') {
        const rows = [];
        if (f.mostCatWins) rows.push(factParts('Most category wins', `<em>${nm(f.mostCatWins.key)}</em>`, ' · ', fmtNum(f.mostCatWins.value), '', ''));
        if (f.bestWeek) rows.push(factParts('Best matchup', nm(f.bestWeek.key), ' · ', fmtNum(f.bestWeek.value), ', ', f.bestWeek.when ? matchupsText(f.bestWeek.when) : ''));
        if (f.longestStreak) rows.push(factParts('Longest streak', nm(f.longestStreak.key), ' · ', `${fmtNum(f.longestStreak.value)} wins`, ', ', matchupsText(f.longestStreak.when)));
        if (f.biggestBlowout) rows.push(factParts('Biggest blowout', teamsLine(f.biggestBlowout, ' over '), ' \u00b7 ', `margin ${fmtNum(f.biggestBlowout.value)}`, ', ', matchupsText(f.biggestBlowout.when)));
        rows.push(closestRow(fmtNum));
        const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
        const cats = extras.leaders ? extras.leaders.categories : [];
        const alone = cats.filter(c => c.leaders.length === 1);
        const shared = cats.filter(c => c.leaders.length > 1);
        const leadRow = (c, cls) => `<div class="lh-lead"><span>${escapeHtml(map[c.statId] || c.statId)}</span><b${cls}>${c.leaders.map(l => nm(l.key)).join(' · ')}</b></div>`;
        const leadersHtml = (alone.length ? `<div class="lh-season-label">Category leaders</div><div class="lh-leaders">${alone.map(c => leadRow(c, '')).join('')}</div>` : '')
            + (shared.length ? `<div class="lh-season-label">Shared</div><div class="lh-leaders">${shared.map(c => leadRow(c, ' class="lh-lead-shared"')).join('')}</div>` : '');
        return wrap(headline, `<div class="lh-season-grid">
                        ${podiumCol}
                        <div class="lh-facts">${rows.join('')}${leadersHtml}</div>
                        <div class="lh-season-third">${pathHtml}${standHtml(['Team', 'W-L-T', 'Cat W', 'Finish'], r => [escapeHtml(r.name), escapeHtml(r.record || ''), r.catWins ?? '', finishText(r)])}</div>
                    </div>`);
    }

    // POINTS SEASON: points are the currency, so the facts are in points and the standings carry what was scored and given up.
    if (format === 'points') {
        const pf = summary.pointsFacts || {};
        const rows = [];
        if (f.bestWeek) rows.push(factParts('Best matchup', nm(f.bestWeek.key), ' · ', pts(f.bestWeek.value), ', ', f.bestWeek.when ? matchupsText(f.bestWeek.when) : ''));
        if (pf.lowestWeek) rows.push(factParts('Lowest matchup', nm(pf.lowestWeek.key), ' · ', pts(pf.lowestWeek.value), ', ', matchupsText(pf.lowestWeek.when)));
        if (pf.highestLoss) rows.push(factParts('Highest score in a loss', nm(pf.highestLoss.key), ' · ', pts(pf.highestLoss.value), ', ', matchupsText(pf.highestLoss.when)));
        if (pf.averages && pf.averages.length) rows.push(factParts('Highest average', nm(pf.averages[0].key), ' · ', pts(pf.averages[0].average), '', ''));
        if (pf.mostAgainst) rows.push(factParts('Most points against', nm(pf.mostAgainst.key), ' · ', pts(pf.mostAgainst.value), '', ''));
        if (f.longestStreak) rows.push(factParts('Longest streak', nm(f.longestStreak.key), ' · ', `${fmtNum(f.longestStreak.value)} wins`, ', ', matchupsText(f.longestStreak.when)));
        if (f.biggestBlowout) rows.push(factParts('Biggest blowout', teamsLine(f.biggestBlowout, ' over '), ' \u00b7 ', `margin ${pts(f.biggestBlowout.value)}`, ', ', matchupsText(f.biggestBlowout.when)));
        rows.push(closestRow(pts));
        return wrap(headline, `<div class="lh-season-grid">
                        ${podiumCol}
                        <div class="lh-facts">${rows.join('')}</div>
                        <div class="lh-season-third">${pathHtml}${standHtml(['Team', 'W-L-T', 'For', 'Against', 'Finish'], r => [escapeHtml(r.name), escapeHtml(r.record || ''), r.pointsFor == null ? '' : pts(r.pointsFor), r.pointsAgainst == null ? '' : pts(r.pointsAgainst), finishText(r)])}</div>
                    </div>`);
    }

    // ROTO SEASON: no schedule, so no matchup facts at all. What a roto season has is its points table: every category's figure and the roto points it earned (ESPN's own where filed), the first place shaded, and each team's total, categories won and gap to the next.
    const table = extras.rotoTable;
    const rotoRows = table ? table.rows : [];
    const rowName = (r) => escapeHtml(nameOf(r.key) || '');
    const rows = [];
    const mostWon = rotoRows.slice().sort((a, b) => b.won - a.won)[0];
    if (mostWon) rows.push(factParts('Most categories won', rowName(mostWon), ' · ', String(mostWon.won), '', ''));
    if (rotoRows[0] && rotoRows[0].marginToNext != null) rows.push(factParts('Margin to second', '', '', `${fmtNum(rotoRows[0].marginToNext)} points`, '', ''));
    const closest = rotoRows.filter(r => r.marginToNext != null).sort((a, b) => a.marginToNext - b.marginToNext)[0];
    if (closest) rows.push(factParts('Closest finish', `${ord(closest.place)} and ${ord(closest.place + 1)}`, ' · ', `${fmtNum(closest.marginToNext)} points`, '', ''));

    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const cats = table ? table.categories : [];
    // A rate prints as ESPN's season rate to three places without its leading zero (".916"); a count as itself.
    const figure = (v) => (v == null ? '' : (Number.isInteger(v) ? String(v) : (Math.abs(v) < 10 ? v.toFixed(3).replace(/^0\./, '.') : fmtNum(v))));
    const catTable = table ? `<div class="lh-season-label">Every category: figure and points</div>
        <div class="lh-roto-wrap"><table class="lh-roto"><thead><tr><th></th>${cats.map(c => `<th>${escapeHtml(map[c.statId] || c.statId)}</th>`).join('')}</tr></thead>
        <tbody>${rotoRows.map(r => `<tr><th>${rowName(r)}</th>${cats.map(c => {
            const cell = r.categories[c.statId] || {};
            return `<td${cell.place === 1 ? ' class="lh-roto-first"' : ''}><b>${cell.points == null ? '' : fmtNum(cell.points)}</b><small>${figure(cell.value)}</small></td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    // The standings of a roto season are its table's: total points, categories won outright, and the gap to the place below.
    const rotoStand = rotoRows.length
        ? `<div class="lh-season-label">Final standings</div><div class="lh-stand2">${standRow(['Team', 'Points', 'Won', 'Behind'], true)}${rotoRows.map(r => standRow([rowName(r), fmtNum(r.total) ?? '', r.won, r.marginToNext == null ? '' : fmtNum(r.marginToNext)])).join('')}</div>`
        : standHtml(['Team', 'Points', 'Finish'], r => [escapeHtml(r.name), r.points ?? '', finishText(r)]);
    return wrap(headline, `<div class="lh-season-grid">
                        ${podiumCol}
                        <div class="lh-facts">${rows.join('')}</div>
                        <div class="lh-season-third">${rotoStand}</div>
                    </div>${catTable}`);
}

// The rivalry pane is a list of opponents beside a detail card, and a row is always selected so the second column is never waiting on a click. Sizes are arithmetic over counts and constants, and a pane too short for the card scrolls it rather than dropping a fact.

// The name column is sized to the widest name actually on screen rather than a fixed width, so a long franchise name is never cut. scrollWidth is read because the opponent cell is clipped to its grid column and its own rect would report the allotted width. The width is capped so one very long name cannot take the bar track.
function sizeRivalryNames(container) {
    const list = container.querySelector('.lh-rivalry-list');
    if (!list) return;
    const opps = [...list.querySelectorAll('.lh-h2h-opp')];
    // scrollWidth only reports the one-line width while nothing wraps the text first, so nowrap is forced for this read alone and removed before the function returns.
    opps.forEach(el => { el.style.whiteSpace = 'nowrap'; });
    let widest = 0;
    opps.forEach(el => { widest = Math.max(widest, el.scrollWidth); });
    opps.forEach(el => { el.style.whiteSpace = ''; });
    if (!widest) return;
    const w = Math.min(200, Math.max(60, Math.ceil(widest) + 2));
    list.style.setProperty('--lh-h2h-name-w', `${w}px`);
}

function rivalryRowsHtml(opponents, rowFor, selectedKey) {
    const nicknames = nicknamesByFranchiseKey();
    return opponents.map(opp => {
        const oppName = nicknames.get(opp.key) || opp.name;
        const rec = rowFor(opp);
        const on = opp.key === selectedKey ? ' selected' : '';
        const common = `data-rival="${escapeHtml(opp.key)}" tabindex="0" role="button" aria-pressed="${opp.key === selectedKey}"`;
        // An opponent never played is stated, not skipped. A franchise that joined last season has never met the one that left two years ago, and that is history rather than missing data.
        if (!rec) {
            return `<div class="lh-h2h-row lh-h2h-unmet${on}" ${common}>
                        <div class="lh-h2h-opp" title="${escapeHtml(opp.name)}">${escapeHtml(oppName)}</div>
                        <div class="lh-h2h-track lh-h2h-track-empty">Never met</div>
                        <div class="lh-h2h-rec">-</div>
                    </div>`;
        }
        const seg = (cls, n) => (n > 0 ? `<span class="${cls}" style="flex-grow:${n}"></span>` : '');
        const record = recordText(rec.w, rec.l, rec.t);
        return `<div class="lh-h2h-row${on}" ${common}>
                    <div class="lh-h2h-opp" title="${escapeHtml(opp.name)}">${escapeHtml(oppName)}</div>
                    <div class="lh-h2h-track">
                        ${seg('lh-h2h-win', rec.w)}${seg('lh-h2h-tie', rec.t)}${seg('lh-h2h-loss', rec.l)}
                    </div>
                    <div class="lh-h2h-rec">${escapeHtml(record)}</div>
                </div>`;
    }).join('');
}

// The facts come in a fixed order and are derived from records already in hand, so the card costs no fetch. A fact that cannot be derived is stated as none rather than approximated. Values abbreviate because a fact is a line in the narrowest column on the tab, while the heading and list rows keep full names.
function rivalryFactsHtml(detail, meShort, oppShort, titles) {
    const nameFor = (side) => (side === 'a' ? meShort : oppShort);
    const fact = (label, value) =>
        `<div class="lh-riv-fact"><span class="lh-riv-fact-l">${escapeHtml(label)}</span><span class="lh-riv-fact-v">${escapeHtml(value)}</span></div>`;

    // EVERY FACT NAMES ITS SUBJECT, in the one "by NAME" form. "Won 2 straight" was ambiguous in the rendered card: the card's own heading is the OPPONENT's name, so a bare Won/Lost read as a claim about them while it was in fact about the franchise in the pager above.
    const streakText = detail.streak
        ? `${detail.streak.count} straight by ${nameFor(detail.streak.side)}`
        : 'None, the last meeting was a tie';
    // The coordinate comes first, then the marker, then who won. Matchup is capitalised to match the run span beside it.
    const last = detail.last;
    const when = last ? `${last.year} Matchup ${last.period}${last.playoff ? ', Playoffs' : ''}` : '';
    const lastText = !last
        ? 'None'
        : (last.result === 'tie' ? `${when}, tied` : `${when}, won by ${nameFor(last.result)}`);
    const rows = [
        fact('Streak', streakText),
        fact('Last meeting', lastText)
    ];
    // The order is fixed, and the depth count says how many of them the height affords.
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
    // Every fact is shown, always. The list is the display order, not a budget.
    RIVALRY_CARD_SECTIONS.forEach(key => rows.push(extras[key]()));
    return rows.join('');
}

function rivalryCardHtml(detail, meName, oppName, titles, shorts) {
    const t = detail.total;
    const played = t.w + t.l + t.t;
    if (!played) {
        // Two states, not one. A pair with only postseason meetings has met, but the record does not count those games, and saying they never played would be false.
        const line = detail.playoff.total
            ? `These two have only met in the playoffs: ${detail.playoff.total}, ${escapeHtml((shorts && shorts.me) || meName)} ${detail.playoff.aWins}, ${escapeHtml((shorts && shorts.opp) || oppName)} ${detail.playoff.bWins}.`
            : 'These two have never played each other.';
        return `<div class="lh-riv-card">
                    <button type="button" class="lh-riv-back" aria-label="Back to the opponents">&#8249; All opponents</button>
                    <div class="lh-riv-opp">${escapeHtml(oppName)}</div>
                    <div class="lh-riv-empty"><span class="lh-riv-dash">&ndash;</span><span class="hint" tabindex="0" role="button" aria-label="About this pairing" data-hint="${escapeHtml(line.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'))}">&#9432;</span></div>
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
                <button type="button" class="lh-riv-back" aria-label="Back to the opponents">&#8249; All opponents</button>
                <div class="lh-riv-opp">${escapeHtml(oppName)}</div>
                <div class="lh-riv-lead">${lead}</div>
                <div class="lh-riv-seasons" style="--lh-riv-season-rows:${Math.max(1, detail.seasons.length)}">${seasons}</div>
                <div class="lh-riv-facts">${rivalryFactsHtml(detail, (shorts && shorts.me) || meName, (shorts && shorts.opp) || oppName, titles)}</div>
            </div>`;
}

function gridHtml(pairs, franchises, countedYears, records, seasons) {
    if (!countedYears.length) {
        return `<div class="lh-block">
                    <div class="lh-block-head">Head to head</div>
                    <div class="lh-note">No season in this league played head-to-head matchups.</div>
                </div>`;
    }
    const byPair = new Map(pairs.map(p => [`${p.a}|${p.b}`, p]));
    // One franchise at a time, in the category pager's arrow language. A grid of franchises grows as the square of the league, and a row is what a reader looks up anyway. The pager opens on the reader's own franchise found by account id; null means nobody has stepped it yet, which separates "not chosen" from "chose the first one".
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
    // Opponents never met go last. They carry no bar and no record, so a muted row between two real rivalries would break the column. Met opponents keep their order, a stable partition and not a re-sort.
    const allOpponents = franchises.filter(f => f.key !== me.key);
    const opponents = [
        ...allOpponents.filter(f => rowFor(f)),
        ...allOpponents.filter(f => !rowFor(f))
    ];
    // The selection survives a pane switch and a data refresh because it lives in state, not in the markup. It falls back to the first opponent only when the selected one is not on this list.
    const selected = opponents.some(o => o.key === state.rivalKey) ? state.rivalKey : (opponents[0] || {}).key;
    state.rivalKey = selected || null;
    const opp = opponents.find(o => o.key === selected) || null;

    const detail = opp ? rivalryDetail(seasons, state.payloads, me.key, opp.key) : null;
    const titleOf = (key) => (records.rows.find(r => r.key === key) || {}).titles || 0;
    const listFraction = rivalrySplit(opponents.length);

    const total = opponents.map(rowFor).filter(Boolean)
        .reduce((acc, r) => ({ w: acc.w + r.w, l: acc.l + r.l, t: acc.t + r.t }), { w: 0, l: 0, t: 0 });
    // Both year lists are computed against the seasons actually in view, so a single focused head-to-head year has nothing left to explain and the sentence stays silent.
    const note = coverageSentence(countedYears, seasons.map(s => s.year));

    // No block heading. The focus pill above already reads "Head to Head", so the heading would only repeat it.
    return `<div class="lh-block">
                <div class="lh-h2h-pager">
                    <button type="button" class="chrome-arrow lh-h2h-prev" aria-label="Previous franchise">&#8249;</button>
                    <div class="lh-h2h-name">${escapeHtml(nicknamesByFranchiseKey().get(me.key) || me.name)}</div>
                    <button type="button" class="chrome-arrow lh-h2h-next" aria-label="Next franchise">&#8250;</button>
                </div>
                <div class="lh-h2h-total">${recordText(total.w, total.l, total.t)} against the league</div>
                ${note ? `<div class="lh-note">${escapeHtml(note)}</div>` : ''}
                <div class="lh-rivalry${state.rivalOpen ? ' lh-open' : ''}" style="--lh-riv-list:${listFraction.toFixed(3)}">
                    <div class="lh-rivalry-list" style="--lh-riv-rows:${Math.max(1, opponents.length)}">
                        ${rivalryRowsHtml(opponents, rowFor, selected)}
                    </div>
                    ${detail && opp
                        ? rivalryCardHtml(detail, nicknamesByFranchiseKey().get(me.key) || me.name, nicknamesByFranchiseKey().get(opp.key) || opp.name, { me: titleOf(me.key), opp: titleOf(opp.key) },
                            { me: me.abbrev || me.name, opp: opp.abbrev || opp.name })
                        : '<div class="lh-riv-card"><div class="lh-riv-empty">This franchise has no opponents on record.</div></div>'}
                </div>
            </div>`;
}

// The union of every category ever scored, each column saying how much of the league's life it covers. Marks answer the yes-or-no question at a glance, and the cross is the quiet colour because an unscored category is history and not a fault.
function categoryTableHtml(union, seasons) {
    if (!union.stats.length) return '';
    const map = ESPN_STAT_MAPS[AppState.loadedSport] || {};
    const byYear = new Map(seasons.map(s => [s.year, new Set(s.statIds)]));
    const years = [...union.years].sort((a, b) => b - a);
    // No coverage count under the name and no caption over the table, since the column of marks already says which seasons scored it. The career table keeps its coverage notes because it has no marks.
    const head = union.stats.map(s => `<th>${escapeHtml(map[s.statId] || s.statId)}</th>`).join('');
    // The season's format sits beside its year, because a row of ticks means something different in a roto season than in a head-to-head one.
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
    // The row pitch comes from the season count, not from the table being told to be tall. categoryRowHeight is pure and tested, and this only hands its answer to CSS.
    const rowH = categoryRowHeight(years.length);
    return `<div class="lh-block">
                <div class="lh-block-head">Categories by season</div>
                <div class="lh-scroll">
                    <table class="lh-table lh-grid lh-cats" style="--lh-cats-row-h:${rowH}px"><thead><tr><th></th><th>Format</th>${head}</tr></thead><tbody>${body}</tbody></table>
                </div>
            </div>`;
}

// Careers is the only part of this tab that costs a player pool per season, so it is the only part that waits to be asked for. Every season counts, including the one being played, so these totals move during a season by design and the block says so.
function careerYears() {
    return state.seasons.map(s => s.year).sort((a, b) => a - b);
}

// The season still being played, which is not the same as the newest one. A finished league's newest season is finished too, so this is the newest unfinished season or nothing.
function liveYear() {
    const newest = state.seasons.reduce((best, s) => (!best || s.year > best.year ? s : best), null);
    return newest && !newest.finished ? newest.year : null;
}

// Is anything still arriving for this pane? This is the one place to change when the harvest is rescheduled. It is stated positively, as something in flight, because a negative test treats every non-terminal status as busy and a resting state such as idle would strand the spinner. It reads status and the outstanding count only, never the harvest's own phase names.
function careersBusy(c) {
    if (!c) return false;
    // Pools in flight. Everything else, whether idle, done or error, is at rest as far as pools go.
    if (c.status === 'loading') return true;
    // Attribution still landing behind a table that is already readable.
    return (c.refining || 0) > 0;
}

// One year's career rows are rebuilt from the pools and ownership already in hand, because buildCareers is pure and cheap and a scoped rebuild is the only way the year's own totals appear. It falls back to the unfiltered rows when the pools have not landed on this state shape, rather than throwing.
function careerRowsForYear(c, year) {
    if (!year) return c.rows;
    if (!c.pools || !c.pools[year]) return c.rows;
    const seasonsByYear = c.seasonsByYear || {};
    return buildCareers({ [year]: c.pools[year] }, { [year]: seasonsByYear[year] }, { [year]: (c.owners || {})[year] });
}

function careerBlockHtml(focusYear) {
    const years = careerYears();
    if (!years.length) {
        return `<div class="lh-block">
                    <div class="lh-block-head">Player careers</div>
                    <div class="lh-note">No season of this league could be read.</div>
                </div>`;
    }
    // Careers is a pane, so being on it is the whole of asking for it. Entering the pane is what pays for the pools, and every other pane renders from payloads already in hand.
    const c = state.careers;
    const live = liveYear();

    // One busy flag covers everything still arriving, the pool counter and the transaction log alike, since both are the same fact to the reader. The table stays on screen while the log lands, and the spinner says the pane is not finished.
    const busy = careersBusy(c);

    // The coverage line is a lead-in and a row of year chips, and the live dot says the totals keep moving without a clause.
    const lead = focusYear ? `Totals for ${focusYear}` : `Totals over ${years.length} ${years.length === 1 ? 'season' : 'seasons'}`;
    const deferred = new Set(c.deferred || []);
    const refused = new Set(c.refused || []);
    const chips = years.map(y => {
        const isLive = live !== null && y === live;
        // A deferred season's transaction log was never requested. Its franchises come from the draft, and its chip is the control that requests the rest, so it is a button and not a span.
        if (deferred.has(y)) {
            // Same control, different sentence. A season that was never asked for and one that was asked for and cut off are both "franchises from the draft, click for the rest", but saying "Load" to someone whose load just stopped would be the app pretending it did not happen. Neutral about cause, per VOICE: what is true is that it stopped.
            const title = refused.has(y)
                ? 'Franchises are from the draft. The rest stopped loading. Click to try again.'
                : "Franchises are from the draft. Load the season's full history.";
            return `<button type="button" class="lh-season-chip is-deferred" data-log-year="${y}"`
                + ` title="${escapeHtml(title)}">`
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
        const tableYears = focusYear ? [focusYear] : years;
        inner = careerTableHtml(careerRowsForYear(c, focusYear), tableYears);
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
    const nicknames = nicknamesByFranchiseKey();
    const nameByKey = new Map(state.franchises.map(f => [f.key, nicknames.get(f.key) || f.name]));
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
        // A count with the names on hover. The names were the widest column in the table for a fact most rows answer with one.
        const names = row.franchiseKeys.map(k => nameByKey.get(k) || 'Unknown');
        // One franchise per line, which the hint layer renders because it sets white-space: pre-line.
        const hint = names.length ? names.join(HINT_BREAK) : 'Never rostered';
        const cells = statIds.map(statId => {
            const v = careerValue(row, statId, specs);
            // Blank, not zero, for a stat with no components behind it. The same rule the category table follows, for the same reason.
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
                ${careerListHtml(rows, statIds, groupKey, map, rateSet, specs, sort)}
            </div>`;
}

// The phone's form of the career table: a search pill and a sort pill over a paged list of lifted cards, twelve a page. A card is the avatar, the name, seasons and franchises, three headline figures, and on a tap the rest. It reads the same rows the table does and is hidden above the phone's width, where the table stays.
const CAREER_PAGE = 12;
const CAREER_SCORING_LABELS = ['PTS', 'FPTS', 'R', 'HR', 'W', 'K'];
function careerScoringId(statIds, map) {
    for (const lab of CAREER_SCORING_LABELS) {
        const hit = statIds.find(id => map[id] === lab);
        if (hit !== undefined) return hit;
    }
    return statIds[0];
}

function careerListHtml(rows, statIds, groupKey, map, rateSet, specs, sort) {
    if (!rows.length) return '';
    const scoring = careerScoringId(statIds, map);
    const key = sort.key || scoring;
    const dir = sort.key ? sort.dir : 'desc';
    const q = String(state.careerQuery || '').trim().toLowerCase();
    const ordered = sortCareers(rows, { key, dir, rateSpecs: specs });
    const matches = q ? ordered.filter(r => String(r.name || '').toLowerCase().includes(q)) : ordered;
    const pages = Math.max(1, Math.ceil(matches.length / CAREER_PAGE));
    const page = Math.max(0, Math.min(pages - 1, Number(state.careerPage) || 0));
    const slice = matches.slice(page * CAREER_PAGE, page * CAREER_PAGE + CAREER_PAGE);
    const sport = AppState.loadedSport;
    const labelOf = (id) => escapeHtml(map[id] || id);
    const figure = (row, id) => {
        const v = careerValue(row, id, specs);
        if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
        return rateSet.has(id) ? Number(v).toFixed(3) : String(Math.round(Number(v)));
    };
    const headline = [scoring];
    if (key !== 'name' && key !== 'seasons' && statIds.includes(key) && !headline.includes(key)) headline.push(key);
    for (const id of statIds) { if (headline.length >= 3) break; if (!headline.includes(id)) headline.push(id); }
    const tile = (row, id) => `<span class="lh-cl-fig"><b>${escapeHtml(figure(row, id))}</b><small>${labelOf(id)}</small></span>`;
    const cards = slice.map(row => {
        const open = state.careerOpen === row.id;
        const seasons = row.seasons.length;
        const rest = statIds.filter(id => !headline.includes(id));
        return `<div class="lh-cl-card${open ? ' open' : ''}" data-career-card="${escapeHtml(String(row.id))}">
                    <div class="lh-cl-top">
                        ${buildPlayerAvatarHtml(sport, row.id, row.name)}
                        <div class="lh-cl-id"><div class="lh-cl-name">${escapeHtml(row.name)}</div>
                            <div class="lh-cl-sub">${seasons} ${seasons === 1 ? 'season' : 'seasons'} &middot; ${row.franchiseKeys.length} ${row.franchiseKeys.length === 1 ? 'franchise' : 'franchises'}</div></div>
                        <button type="button" class="lh-cl-more" aria-expanded="${open}" aria-label="All figures">&#8250;</button>
                    </div>
                    <div class="lh-cl-figs">${headline.map(id => tile(row, id)).join('')}</div>
                    ${rest.length ? `<div class="lh-cl-all">${rest.map(id => tile(row, id)).join('')}</div>` : ''}
                </div>`;
    }).join('');
    const sortName = key === 'name' ? 'Name' : key === 'seasons' ? 'Seasons' : (map[key] || key);
    const sheet = state.careerSheet
        ? `<div class="lh-cl-sheet" role="menu">${[['name', 'Name'], ['seasons', 'Seasons'], ...statIds.map(id => [id, map[id] || id])]
            .map(([k, l]) => `<button type="button" class="lh-cl-pick${k === key ? ' on' : ''}" data-career-pick="${escapeHtml(String(k))}" data-career-group="${groupKey}">${escapeHtml(l)}</button>`).join('')}</div>`
        : '';
    const from = matches.length ? page * CAREER_PAGE + 1 : 0;
    const to = Math.min(matches.length, page * CAREER_PAGE + CAREER_PAGE);
    return `<div class="lh-career-list">
                <div class="lh-cl-bar">
                    <input type="search" class="lh-cl-search" data-career-q placeholder="Search players" aria-label="Search players" value="${escapeHtml(state.careerQuery || '')}">
                    <button type="button" class="lh-cl-sort" data-career-sheet aria-haspopup="true" aria-expanded="${!!state.careerSheet}">${escapeHtml(sortName)}</button>
                </div>
                ${sheet}
                <div class="lh-cl-cards">${cards || '<div class="lh-note">No players match.</div>'}</div>
                <div class="lh-cl-pager">
                    <button type="button" class="lh-cl-step" data-career-page="-1" aria-label="Previous page"${page === 0 ? ' disabled' : ''}>&#8249;</button>
                    <span class="lh-cl-of">${matches.length ? `${from}&ndash;${to} of ${matches.length}` : 'No players'}</span>
                    <button type="button" class="lh-cl-step" data-career-page="1" aria-label="Next page"${page >= pages - 1 ? ' disabled' : ''}>&#8250;</button>
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
        // Eligibility can be missing for a player the pool no longer carries a position for. The row is kept and goes with the outfield players, whose columns are the counting stats every sport shares.
        if (!role.primary && !role.secondary) acc.primary.push(row);
        return acc;
    }, { primary: [], secondary: [] });

    // One group at a time behind pills, the same pattern My Team's Categories and Schedule faces use. Stacked, the two tables split a band too short for either, and the pill carries the count so the other group is closed and never hidden.
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
    // The error status is terminal for this auto-trigger. Attribution can publish an error while the ownership walk is still in flight and every repaint calls back in here, so letting it pass launched a concurrent walk per render. Leaving and re-entering the careers pane resets to idle, which is the retry.
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

    // Rebuilt from the pools in hand each time attribution improves, which is arithmetic over cached data and no refetch. The owners map and the deferred list ride on state so a later per-season load merges into what is already attributed.
    const attribute = (owners, refining) => {
        if (state.key !== key) return;
        const rows = buildCareers(pools, seasonsByYear, owners);
        const status = rows.length || Object.keys(pools).length ? 'done' : 'error';
        state.careers = {
            status, rows, loaded: years.length, total: years.length, years, phase: 'done', refining,
            deferred: state.careers.deferred || [], refused: state.careers.refused || [],
            logYears: state.careers.logYears, owners, pools, seasonsByYear
        };
        render(container);
    };

    // Who held each player, drafted first and then walked on demand. The full transaction log is requested for the two most recent seasons only, and every older season renders on draft attribution with its chip offering the rest.
    const live = AppState.rosterTransactionData && AppState.apiData
        ? { year: AppState.apiData.seasonId, picks: AppState.rosterTransactionData.picks, transactions: AppState.rosterTransactionData.transactions }
        : null;
    if (!state.careers.logYears) state.careers.logYears = years.slice(-2);
    let outstanding = 0;
    // The race may be mid-harvest of the live season. Handing its promise down lets that season join the walk already running instead of starting a second one.
    const livePending = liveHarvestInFlight();
    const owners = await loadHistoryOwnership(AppState.loadedSport, AppState.apiData.id, years, state.payloads, {
        liveSeason: live,
        liveSeasonPending: livePending,
        fullLogYears: state.careers.logYears,
        // The loader says which seasons still owe a transaction log, so the note counts the real remainder. A deferred season is a third state, not owed but offered.
        onDrafts: (draftOwners, walkingYears, deferredYears) => {
            outstanding = walkingYears.length;
            state.careers.deferred = deferredYears;
            attribute(draftOwners, outstanding);
        },
        onSeason: (year, soFar) => {
            outstanding = Math.max(0, outstanding - 1);
            attribute(soFar, outstanding);
        },
        // The walk stopped short because the host was refusing. A refused season is offered, like a deferred one, so its chip becomes the ask-again control, and it leaves logYears because this pane no longer holds its full log.
        onRefused: (refusedYears) => {
            if (state.key !== key || !refusedYears.length) return;
            state.careers.refused = refusedYears;
            state.careers.deferred = [...new Set([...(state.careers.deferred || []), ...refusedYears])];
            state.careers.logYears = (state.careers.logYears || []).filter(y => !refusedYears.includes(y));
            render(container);
        }
    });
    if (state.key !== key) return;
    attribute(owners, outstanding);
}

// One deferred season's full log, requested by its chip. On completion its attribution merges into the table in place, and the guard stops a double click from starting two walks.
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
            ...state.careers, rows, owners: merged, pools, seasonsByYear,
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
    const nicknames = nicknamesByFranchiseKey();
    const nameByKey = new Map(state.franchises.map(f => [f.key, nicknames.get(f.key) || f.name]));
    const nameOf = (key) => nameByKey.get(key) || 'Unknown';
    const records = allTimeRecords(state.seasons);
    const total = state.seasons.length;

    // The all-time standings box always reads every season, but the focus pane filters to the selected year, since a season picked in the strip is a question about that year. With "All time" selected this is a no- op.
    const focusYear = state.focusYear;
    const focusSeasons = focusYear ? state.seasons.filter(s => s.year === focusYear) : state.seasons;
    const focusRecords = focusYear ? allTimeRecords(focusSeasons) : records;
    const union = categoryUnion(focusSeasons);
    const pairs = headToHead(focusSeasons, state.payloads);
    const gridFranchises = state.franchises;

    // The season card comes from the pure summarizer and is never built for "All time", since it is one season's story.
    const focusPayload = focusYear ? state.payloads[focusYear] : null;
    // The two per-format readers run once here, off the payload. Each returns null for a format it does not describe, and the roto table falls back to rank-engine's own roto points for a cell ESPN left empty.
    const seasonBox = focusYear
        ? seasonBoxHtml(seasonSummary(focusPayload, state.franchises, { tallyOf: matchupTally, pointsOf: matchupPoints }), nameOf, {
            leaders: seasonCategoryLeaders(focusPayload),
            rotoTable: rotoSeasonTable(focusPayload, { rotoPointsOf: rotoPointsForCategory })
        })
        : '';

    // Three zones. The rail is the champions, the standings sit at the top of the main area, and the focus pane takes all the remaining height. There is no open or closed state on this tab, so no combination of league size and collapsed bands can leave grey space.
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
        ? gridHtml(pairs, gridFranchises, focusRecords.countedYears, focusRecords, focusSeasons)
        : (activePane === 'categories' ? categoryTableHtml(union, focusSeasons) : careerBlockHtml(focusYear));

    container.innerHTML = `
        <div class="lh-layout">
            <aside class="lh-rail" data-sport="${escapeHtml(AppState.loadedSport || '')}">${railHtml(state.seasons, nameOf, focusYear)}</aside>
            <div class="lh-main">
                ${standingsHtml(records, total)}
                ${yearStripHtml(state.seasons, focusYear)}
                ${seasonBox}
                <div class="lh-focus">
                    <div class="mt-view-tabs lh-focus-tabs">${pills}</div>
                    <div class="lh-focus-pane">${paneBody}</div>
                </div>
            </div>
        </div>`;

    // Measured before anything else reads the DOM, so the column is its final width by the time the rest of this function's own listeners and tooltips attach.
    sizeRivalryNames(container);
    if (window.leaguewiseFitNow) window.leaguewiseFitNow();

    // The franchise counts carry their names on hover, through the app's shared hint layer.
    attachDataTooltips(container);

    // The pennant logos are avatar images too, so they take the same wiring the rosters use. It removes an image that fails instead of leaving a broken glyph, and counts the request for the diagnostic tally.
    wirePlayerAvatars(container);

    // The champion's colour is painted in after the fact and not awaited, so the wall is complete the moment it renders. A rejection can only mean a logo that could not be sampled, which the ladder already treats as ordinary.
    dyeChampionFlags(container);
    fitPennantLegends(container);
    requestAnimationFrame(() => fitPennantLegends(container));

    // Opening the careers pane is what pays for the pools, exactly as opening the old block did. Every other pane renders from payloads already in hand, so the fetch still happens only when somebody asks for careers and never on the way past.
    container.querySelectorAll('[data-focus-pane]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.focusPane = btn.dataset.focusPane;
            // An explicit re-entry is the one retry after an error. The render path treats error as terminal, so without this reset a failed careers load could never be retried.
            if (state.focusPane === 'careers' && state.careers.status === 'error') state.careers = emptyCareers();
            render(container);
            if (state.focusPane === 'careers') ensureCareers(container, state.key);
        });
    });
    if (activePane === 'careers') ensureCareers(container, state.key);

    // A new column opens descending and clicking it again flips, as the leaderboard does. The one departure is a lower-is-better category, which opens ascending so the first click puts the best career on top. Player opens A to Z for the same reason.
    const inverse = leagueInverseIds(AppState.loadedSport);
    // The pills only change which table is drawn. careerSort is keyed by group and is not touched here, which is what makes a sort survive switching away and back.
    container.querySelectorAll('[data-career-group-pill]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.careerGroup = btn.dataset.careerGroupPill;
            state.careerPage = 0;
            state.careerOpen = null;
            state.careerSheet = false;
            render(container);
        });
    });

    // The list's own controls: search, the sort sheet, the pager and a card. Each is state and a redraw; the search puts the caret back, since the redraw replaces the input it was typed in.
    const careerQ = container.querySelector('[data-career-q]');
    if (careerQ) {
        careerQ.addEventListener('input', () => {
            state.careerQuery = careerQ.value;
            state.careerPage = 0;
            render(container);
            const again = container.querySelector('[data-career-q]');
            if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
        });
    }
    container.querySelector('[data-career-sheet]')?.addEventListener('click', () => {
        state.careerSheet = !state.careerSheet;
        render(container);
    });
    container.querySelectorAll('[data-career-pick]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.careerPick;
            const group = btn.dataset.careerGroup;
            state.careerSort[group] = { key, dir: key === 'name' ? 'asc' : openingSortDir(key, inverse) };
            state.careerSheet = false;
            state.careerPage = 0;
            render(container);
        });
    });
    container.querySelectorAll('[data-career-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.careerPage = Math.max(0, (Number(state.careerPage) || 0) + Number(btn.dataset.careerPage));
            state.careerOpen = null;
            render(container);
        });
    });
    container.querySelectorAll('[data-career-card]').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const id = Number(card.dataset.careerCard);
            state.careerOpen = state.careerOpen === id ? null : id;
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
            // Under 700px the list and the card take turns, and a pick opens the card; above that the class does nothing.
            state.rivalOpen = true;
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
        state.rivalOpen = false;
        render(container);
    };
    container.querySelectorAll('.lh-riv-back').forEach(btn => {
        btn.addEventListener('click', () => {
            state.rivalOpen = false;
            render(container);
        });
    });
    container.querySelector('.lh-h2h-next')?.addEventListener('click', () => stepRow(1));
    container.querySelector('.lh-h2h-prev')?.addEventListener('click', () => stepRow(-1));

    // A deferred season's chip requests its own transaction log. stopPropagation keeps the click a data request and nothing a parent might listen for.
    container.querySelectorAll('.lh-season-chip.is-deferred').forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            loadDeferredSeasonLog(container, state.key, Number(chip.dataset.logYear));
        });
    });

    // The pennant and the year chip select the same state. Loading a season into the dashboard belongs to the season box's own link, while a pennant or chip stays on this tab and shows the season card. "All time" restores every pane.
    const selectYear = (year) => {
        state.focusYear = year;
        render(container);
    };
    container.querySelectorAll('[data-focus-year]').forEach(el => {
        const pick = () => selectYear(el.dataset.focusYear ? Number(el.dataset.focusYear) : null);
        el.addEventListener('click', pick);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });

    container.querySelectorAll('[data-open-year]').forEach(link => {
        link.addEventListener('click', () => {
            const year = link.dataset.openYear;
            const select = document.getElementById('year');
            if (select && [...select.options].some(o => o.value === year)) {
                select.value = year;
                document.getElementById('fetch-btn')?.click();
            }
        });
    });
}

/**
 * Renders the League History tab into `#history-container`. The first call for a league fetches
 * every season payload it can reach and shows progress while they arrive; later calls repaint
 * from the cached state.
 *
 * Writes a prompt into the container when no league has been fetched yet.
 * @returns {Promise<void>} Resolves once the seasons have loaded and the tab is painted.
 */
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

    // The years are never anchored to the loaded year, because what the dashboard shows has nothing to do with how long the league has existed. Seasons this session has loaded count too, so the strip keeps its newer years after a trip to an older one.
    const years = leagueSeasonYears(
        [...(AppState.leagueHistoryYears || []), ...seasonsSeenFor(sport, leagueId)],
        AppState.apiData.seasonId, new Date().getFullYear());

    state = { key, status: 'loading', seasons: [], payloads: {}, franchises: [], loaded: 0, total: years.length, gridRow: null, rivalKey: null, careerSort: defaultSorts(), careerGroup: 'primary', focusPane: 'h2h', focusYear: null, careers: emptyCareers() };
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
