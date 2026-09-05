// THE TEAM/CLUB PICKER RAIL. Pure renderer over data the caller (players.js) already gathers the same way the old breakout tabs always did (which fantasy teams and pro clubs are present in the filtered pool); this module only draws it - "All" a plain chip, every fantasy team a crest at the pro clubs' own 23px, overlapping by five pixels and ringed in its own legend colour, the active one raised on top; a divider; then the pro-club crest row, unchanged since. No caption anywhere (the owner's "remove clubs from in between" - the planner's reading was both captions, not only the one named, since the divider and each crest's own hover already say which group is which). Full rationale: tests/fixtures/player-rail.md. PURITY CONTRACT, same as leaderboard-row.js/off-night-band.js: no imports, no AppState, no DOM, no fetch. escapeHtml/crestHtml arrive via opts for the same reason every other pure renderer in this codebase takes them that way - the real crest builder lives in images.js, and this module is not allowed to know ESPN's CDN exists.
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

// "All" is the one entry that stays a plain text chip - every real team is a crest now, but "All" has no logo and no legend colour of its own to draw one from.
function allChipHtml(active, o) {
    const isActive = active.kind === 'all';
    return `<button type="button" class="lb-rail-chip${isActive ? ' active' : ''}" data-kind="all" data-id="">${o.escapeHtml('All')}</button>`;
}

// R2/S51 (frame I1): a fantasy team is a crest now, the same size and two-layer shape as a pro club's (.lb-rail-crest), ringed in the team's own legend colour via a custom property rather than a class per team - thirty leagues' worth of colours cannot each get a class, and the ring needs to be exactly this team's colour, not one of a fixed palette. --fteam-color is read by dashboard.css; a null colour (a team the caller could not resolve one for) leaves the property unset and the CSS's own fallback (a neutral border) draws instead of an invalid colour value.
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

// `active`: { kind: 'all' | 'fantasy' | 'pro', id }, the caller's real persisted filter state - this module has none of its own, the same caller-owns-the-state convention every pure renderer in this codebase follows. `teams`: [{ id, label, color, crestHtml }], present teams only - "All" is NOT in this list, added here. `crestHtml` is opts-free (the caller already resolved it, buildTeamCrestHtml, images.js) since a fantasy team's crest is per-team markup, not a per-club abbreviation this module could ask opts.crestHtml to build the way it does for pro clubs below. `clubs`: [{ id, abbrev, name }] | null - null (not []) means no schedule is in hand this session; a real empty array (a search matching no club) still draws an empty crest row.
export function buildPlayerRailHtml({ active, teams, clubs }, opts) {
    const o = resolveOpts(opts);
    const a = active || { kind: 'all', id: null };
    const teamList = teams || [];
    if (!teamList.length && clubs === null) return '';

    // R6/S45: "All" (and the Teams group that carries it) renders whenever the rail renders ANYTHING, not only when real fantasy-team crests exist beside it - measured cause: a preseason pool is every player a free agent, so teamList is genuinely empty, and the old `teamList. length ?` gate dropped the whole Teams group, All included, the moment it was. A club could still be picked below with no way to clear it - "in the preseason a selected team cannot be unselected: there is no All chip" was exactly this gate. The function has already returned above when there is truly nothing to show at all, so by this line teamList.length > 0 OR clubs !== null - either way there is a real filter state All needs to be able to clear. R2/S51 (frame I1): no "Teams" caption any more (both captions are gone - see the module header) - "All" stays a plain chip, every real team is a crest, overlapping by design (.lb-rail-fteam's own negative margin, dashboard.css) so a deep league reads as one dense strip rather than the wide chip row this replaced.
    const teamsHtml = `<div class="lb-rail-chips">${allChipHtml(a, o)}</div>`
        + `<div class="lb-rail-fteams">${teamList.map(t => teamCrestHtml(t, a, o)).join('')}</div>`;

    // R1: one caption for the whole rail, retired entirely by R2/S51 - the divider alone marks where clubs begin now, since a reader can already see fantasy crests give way to pro ones without a label repeating the fact. R5/S45 (the owner's third pass): the active club's name beside the crest row is GONE - "just the yellow highlighting is enough." The ring (.lb-rail-crest.active) is the whole signal now; every crest still carries its own name in a native title attribute for a hover.
    let clubsHtml = '';
    if (clubs !== null) {
        clubsHtml = `<div class="lb-rail-crests">`
            + clubs.map(c => clubCrestHtml(c, a, o)).join('')
            + `</div>`;
    }

    // R1/S26c: the row spreads without wrapping the crests - the two groups are NOT equal halves (that wrapped 32 crests into a ragged second row at 1920, worse than the packed single row it replaced). Teams sizes to its own content (.lb-rail-group-teams, flex:0 0 auto); clubs takes every remaining px (.lb-rail-group-crests, flex:1 1 0) and spreads its own crests across that width with its own space-between, staying one line at every width.lb-rail-crests' own "no wrap at desktop widths" rule already promises. The divider rides inside the clubs group, at its own leading edge, so it travels with clubs as the row widens.
    const dividerHtml = (teamsHtml && clubsHtml) ? `<span class="lb-rail-divider" aria-hidden="true"></span>` : '';
    return `<div class="lb-rail" role="tablist" aria-label="Filter by team or club">`
        + (teamsHtml ? `<div class="lb-rail-group lb-rail-group-teams">${teamsHtml}</div>` : '')
        + (clubsHtml ? `<div class="lb-rail-group lb-rail-group-crests">${dividerHtml}${clubsHtml}</div>` : '')
        + `</div>`;
}
