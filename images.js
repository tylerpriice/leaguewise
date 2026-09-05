// Player imagery, shared plumbing. My Team is the first surface to use it; the leaderboard and the drill-down adopt the same helpers later, which is why this lives in its own module rather than inside players.js. PRIVACY BOUNDARY. These are the only requests the extension makes outside ESPN's fantasy API. An image request sends nothing but the URL, which carries a public athlete id and no league, team or account identifier. Recorded as a Decision in ROADMAP.md, and the privacy copy in the README and both store listings is amended in the same release.

import { escapeHtml, countImageRequest } from './utils.js';

// VALIDATED against real player ids taken from captured payloads, by loading each URL and confirming it decodes (600x436 in both sports): flb 39832 Shohei Ohtani, 4917694 Elly De La Cruz fhl 4063433 Alex DeBrincat, 3041969 Nathan MacKinnon ffl 4429795 Jahmyr Gibbs, 3117251 Christian McCaffrey, 3918298 Josh Allen (re-validated the same way, ids taken from the captured football pool; all three decode at the same 600x436, and the host is the one the other two sports already use, so this adds no permission and no privacy surface - see the boundary note at the top of this file) A deliberately invalid id (99999999) fires the image's error event rather than serving a placeholder, which is what makes the fallback tile below reachable and worth having. The fantasy playerId IS the athlete id in this path; nothing needs translating.
const HEADSHOT_BASE = {
    flb: 'https://a.espncdn.com/i/headshots/mlb/players/full/',
    fhl: 'https://a.espncdn.com/i/headshots/nhl/players/full/',
    ffl: 'https://a.espncdn.com/i/headshots/nfl/players/full/'
};

// Null for an unsupported sport, a missing id, or an id that cannot BE an athlete, so callers render the fallback tile instead of requesting a URL that cannot resolve. A NEGATIVE ID IS NOT A PERSON. Football's team defences are pool entries like anyone else, but they are entities rather than athletes and ESPN gives them negative ids - measured on the real pool: all 32 D/ST carry one, all 1,059 humans carry a positive id, and the split agrees exactly with defaultPositionId 16. Without this guard a defence would request.../-16007.png, take a 404, and land on the initials tile anyway - the same picture, one wasted request and one wrong claim (that a photo was expected) per defence per render. The tile is the RIGHT answer for a team, not a consolation, so it is chosen deliberately rather than arrived at by failure.
export function headshotUrl(sport, playerId) {
    const base = HEADSHOT_BASE[sport];
    if (!base || playerId == null || playerId < 0) return null;
    return `${base}${playerId}.png`;
}

// VALIDATED against real abbreviations, both this app's own PRO_TEAM_ABBREVS (buildProTeamAbbrevs, probables.js - the fantasy-side field, NOT ESPN's asset-path convention) and well-known ones, by loading each URL and confirming it decodes (500x500): flb "lad" AND "LAD" (Dodgers, case-insensitive), "Ath" (Athletics - the mixed-case fantasy abbrev works UNCHANGED, no lowercasing or translation needed), "Wsh" (Nationals) fhl "nj" (Devils, this app's own two-letter fantasy abbrev for New Jersey) ffl "kc" (Chiefs) - the URL PATTERN only; no captured proTeamSchedules_wl response for football exists in JSON_debug to cross-check this app's own buildProTeamAbbrevs output against, so football is confirmed for the CDN path, not for this app's field A deliberately wrong abbreviation ("zzz") returns an empty response rather than a decoded image, confirmed the same way headshotUrl's own invalid-id case was - the real failure path this needs, since an unmapped or misspelled abbreviation is not a hypothetical. this app's own proAbbrev value is passed straight through, unmodified - no case change, no per-sport lookup table. Same host as headshotUrl (a.espncdn.com), so this adds no new permission and no new privacy surface (see the boundary note at the top of this file).
const LOGO_SPORT_PATH = { flb: 'mlb', fhl: 'nhl', ffl: 'nfl' };

// Null for an unsupported sport or a missing/blank abbreviation, so callers render nothing (the backlog's own "no logo, exactly today's layout" rule) rather than requesting a URL that cannot resolve. Unlike headshotUrl there is no fallback TILE - a team logo that is missing says nothing was ever expected there, where a missing headshot still owes the reader an initials tile because a person WAS expected.
export function proTeamLogoUrl(sport, abbrev) {
    const path = LOGO_SPORT_PATH[sport];
    if (!path || !abbrev) return null;
    return `https://a.espncdn.com/i/teamlogos/${path}/500/${abbrev}.png`;
}

// Up to two initials from a name, the fallback tile's whole content.
export function initialsFor(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// The avatar cell: a lazy-loading headshot over an initials tile that is ALREADY in the markup. The tile is what shows until (and unless) the image decodes, so a missing headshot, an offline dev-preview and a slow network all look the same and none of them ever shows a broken-image glyph. Only rendered rows carry an <img>, so nothing is requested for a row that is not drawn.
export function buildPlayerAvatarHtml(sport, playerId, name) {
    const url = headshotUrl(sport, playerId);
    const tile = `<span class="avatar-initials">${escapeHtml(initialsFor(name))}</span>`;
    if (!url) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

// The pro-team logo, beside a player's name. No tile underneath - an empty string when the abbreviation is missing or unmapped, so a row with no club to show draws exactly as it did before this feature, per the backlog's own "no logo, exactly today's layout" rule (unlike a headshot, no PERSON was ever expected here for the tile to stand in for). The <img> still carries avatar-img, the same class wirePlayerAvatars already wires everywhere else - its own error handler removes a failed image outright (closest('.player-avatar') finds none here and skips the tile-reveal step, which this markup has no tile for anyway) and its own load handler still counts the real request either way.
export function buildProTeamLogoHtml(sport, abbrev) {
    const url = proTeamLogoUrl(sport, abbrev);
    if (!url) return '';
    return `<span class="pro-team-logo"><img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

// The rail's FANTASY team crest. Reuses isAllowedLogoUrl (the same ESPN-family-hosts-only gate docs/DATA-SOURCES.md section 10 rules for League History's own flag badge) rather than a second host check - a league manager's logo field is exactly as untrusted here as it is there, and "not loaded means no request is made" is the whole point either way. ALWAYS renders a tile now. `label` prints VERBATIM in the tile, not initialsFor(label) - the caller already resolved it to the league's own short form (`team.abbrev || team.name`), and re-deriving initials from an already-short code ("MDST") would throw most of it away for a single letter.
export function buildTeamCrestHtml(label, logoUrl) {
    const tile = `<span class="avatar-initials">${escapeHtml(label || '')}</span>`;
    if (!isAllowedLogoUrl(logoUrl)) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(logoUrl)}"></span>`;
}

// The rail's club crest: a pro-team logo over an initials tile, buildPlayerAvatarHtml's two-layer trick reused for a club instead of a person -.player-avatar/.avatar-initials/.avatar-img, so wirePlayerAvatars' existing error/load handling (and its has-image tile-hide rule) apply with no second copy. The tile prints the club's own abbreviation rather than initials-from-a-name, since a club already IS its abbreviation - there is no name to initial.
export function buildProTeamCrestHtml(sport, abbrev) {
    const tile = `<span class="avatar-initials">${escapeHtml(abbrev || '')}</span>`;
    const url = proTeamLogoUrl(sport, abbrev);
    if (!url) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

// Extension pages run under a CSP that blocks inline handlers, so the error path is wired here rather than with an onerror attribute. A failed image is removed outright, which uncovers the tile underneath; a loaded one marks its wrapper so the tile hides.
export function wirePlayerAvatars(container) {
    container.querySelectorAll('img.avatar-img').forEach(img => {
        if (img.dataset.wired) return;
        img.dataset.wired = '1';
        // The tally counts a request that really happened, so it is incremented when the browser reports back - load or error, either of which means the request went out - and NOT when the tag is written. These images are loading="lazy", and counting at render measured that honestly wrong: a history rail of three logos reported three loads while all three were still img.complete === false and no request had left the browser. Once per image, since dataset.wired above already guarantees one wiring pass each and the flag below guards the load-then-error case. A logo the host allowlist refused never became an img at all, so it is correctly counted nowhere.
        let counted = false;
        const count = () => {
            if (counted) return;
            counted = true;
            countImageRequest(img.getAttribute('src'));
        };
        const done = () => {
            count();
            img.closest('.player-avatar')?.classList.add('has-image');
        };
        if (img.complete && img.naturalWidth > 0) done();
        img.addEventListener('load', done);
        img.addEventListener('error', () => { count(); img.remove(); });
    });
}

// ESPN-FAMILY HOSTS ONLY. A team logo is rendered only when ESPN itself is serving it. Anything else is not loaded at all - and "not loaded" has to mean no request, not a hidden image, because the request IS the disclosure: it hands the viewer's IP and referer to whatever host a league manager happened to paste. That is measured, not theoretical - of 4 logos found across 36 teams, three were on g.espncdn.com and one was a YouTube thumbnail on i.ytimg.com (docs/DATA-SOURCES.md section 10). An ESPN-hosted logo costs nothing new: it is an img tag under the same CSP as the player headshots, no host permission and no manifest change, and the published privacy line about images loading from ESPN's CDN stays true. Exact host or a subdomain of it - never a substring test, which "espn.com.evil.example" would pass. Anything unparseable is refused, since a URL nobody can read is a URL nobody can vet.
const LOGO_HOST_ALLOWLIST = ['espn.com', 'espncdn.com'];

export function isAllowedLogoUrl(url) {
    if (!url) return false;
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return LOGO_HOST_ALLOWLIST.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

// The pennant's badge: a felt monogram, with the logo laid over it only when the host passes. The monogram is the COMMON case - 32 of the 36 teams measured have no logo at all - so it is built to look finished on its own rather than like something waiting for an image. Same two-layer trick as the player avatar: the tile is already in the markup, and the image (if any) covers it.
export function buildTeamLogoHtml(name, logoUrl) {
    const tile = `<span class="lh-flag-monogram">${escapeHtml(initialsFor(name))}</span>`;
    if (!isAllowedLogoUrl(logoUrl)) return `<span class="lh-flag-badge">${tile}</span>`;
    return `<span class="lh-flag-badge">${tile}<img class="lh-flag-logo avatar-img" loading="lazy" alt="" src="${escapeHtml(logoUrl)}"></span>`;
}
