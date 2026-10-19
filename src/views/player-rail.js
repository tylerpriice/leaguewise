/**
 * The team and club picker rail for Player Metrics: an "All" chip, then every fantasy team as a
 * crest ringed in its own legend colour and overlapping the next, a divider, then the pro-club
 * crests as one row. The active entry is ringed and there is no caption anywhere.
 *
 * Pure. No imports, no application state, no DOM and no network; the escaper and the club crest
 * builder arrive in the options.
 *
 * Contract: tests/fixtures/player-rail.md
 * @module player-rail
 */
/**
 * @typedef {Object} RailActive The current filter.
 * @property {'all'|'fantasy'|'pro'} kind Which group the active entry is in.
 * @property {?number} [id] The active team or club id.
 */
/**
 * @typedef {Object} RailTeam A fantasy team present in the pool.
 * @property {number} id The team id.
 * @property {string} label The team's short name, used as the hover title.
 * @property {?string} [color] The team's legend colour.
 * @property {string} crestHtml The crest markup, built by the caller.
 */
/**
 * @typedef {Object} RailClub A pro club present in the pool.
 * @property {*} id The club id.
 * @property {string} abbrev The club abbreviation.
 * @property {string} [name] The full name, used as the hover title.
 */
/**
 * Escapes a value for use in HTML text and attributes.
 *
 * @param {*} str The value.
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

function resolveOpts(opts) {
    const o = opts || {};
    return {
        escapeHtml: o.escapeHtml || escapeHtmlLocal,
        crestHtml: o.crestHtml || (() => ''),
    };
}

// "All" is the one plain text chip, since it has no logo or legend colour to draw a crest from.
function allChipHtml(active, o) {
    const isActive = active.kind === 'all';
    return `<button type="button" class="lb-rail-chip${isActive ? ' active' : ''}" data-kind="all" data-id="">${o.escapeHtml('All')}</button>`;
}

// A team's ring colour rides as a custom property, since each team's colour cannot have its own class; a null colour leaves it unset so the stylesheet's fallback border draws.
function teamCrestHtml(team, active, o) {
    const isActive = active.kind === 'fantasy' && active.id === team.id;
    const name = o.escapeHtml(team.label);
    const styleAttr = team.color ? ` style="--fteam-color:${o.escapeHtml(team.color)}"` : '';
    return `<button type="button" class="lb-rail-fteam${isActive ? ' active' : ''}" data-kind="fantasy" data-id="${o.escapeHtml(String(team.id))}" title="${name}"${styleAttr}>${team.crestHtml}</button>`;
}

function clubCrestHtml(club, active, o) {
    const isActive = active.kind === 'pro' && active.id === club.id;
    const name = o.escapeHtml(club.name || club.abbrev);
    return `<button type="button" class="lb-rail-crest${isActive ? ' active' : ''}" data-kind="pro" data-id="${o.escapeHtml(String(club.id))}" title="${name}">${o.crestHtml(club.abbrev)}</button>`;
}

/**
 * Builds the rail as an HTML string. The caller owns the filter state.
 *
 * @param {Object} model The rail's content.
 * @param {RailActive} [model.active] The current filter; "All" when absent.
 * @param {RailTeam[]} [model.teams] The fantasy teams present, without "All", which is added here.
 * @param {?RailClub[]} model.clubs The clubs present, or null when no schedule is in hand (an empty array still draws an empty row).
 * @param {Object} [opts] Options.
 * @param {function(*): string} [opts.escapeHtml] The HTML escaper; a built-in one when absent.
 * @param {function(string): string} [opts.crestHtml] Builds a club crest from its abbreviation.
 * @returns {string} The markup, or an empty string when there is nothing to show.
 */
export function buildPlayerRailHtml({ active, teams, clubs }, opts) {
    const o = resolveOpts(opts);
    const a = active || { kind: 'all', id: null };
    const teamList = teams || [];
    if (!teamList.length && clubs === null) return '';

    // "All" renders whenever the rail renders anything, so a club picked in the preseason can still be cleared when no team crests exist. There are no captions; the divider and each crest's hover title say which group is which.
    const teamsHtml = `<div class="lb-rail-chips">${allChipHtml(a, o)}</div>`
        + `<div class="lb-rail-fteams">${teamList.map(t => teamCrestHtml(t, a, o)).join('')}</div>`;

    // No caption and no active-club name; the ring on the active crest is the whole signal, and every crest carries its name as a hover title.
    let clubsHtml = '';
    if (clubs !== null) {
        clubsHtml = `<div class="lb-rail-crests">`
            + clubs.map(c => clubCrestHtml(c, a, o)).join('')
            + `</div>`;
    }

    // The clubs group takes the remaining width and spreads its crests on one line, so a long club list does not wrap into a ragged second row.
    const dividerHtml = (teamsHtml && clubsHtml) ? `<span class="lb-rail-divider" aria-hidden="true"></span>` : '';
    return `<div class="lb-rail" role="tablist" aria-label="Filter by team or club">`
        + (teamsHtml ? `<div class="lb-rail-group lb-rail-group-teams">${teamsHtml}</div>` : '')
        + (clubsHtml ? `<div class="lb-rail-group lb-rail-group-crests">${dividerHtml}${clubsHtml}</div>` : '')
        + `</div>`;
}
