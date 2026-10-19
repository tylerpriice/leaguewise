/**
 * Shared image helpers: URL builders for player headshots and club logos, the initials tile used
 * when a picture is missing, and the wiring that removes a failed image.
 *
 * An image request carries only a public URL. Team logos load only from ESPN-family hosts.
 *
 * @module images
 */

import { escapeHtml, countImageRequest } from './utils.js';

// The headshot path is per sport, and the fantasy player id is the athlete id, so nothing is translated.
const HEADSHOT_BASE = {
    flb: 'https://a.espncdn.com/i/headshots/mlb/players/full/',
    fhl: 'https://a.espncdn.com/i/headshots/nhl/players/full/',
    ffl: 'https://a.espncdn.com/i/headshots/nfl/players/full/'
};

/**
 * The headshot URL for a player.
 *
 * @param {string} sport The sport key ('flb', 'fhl' or 'ffl').
 * @param {?number} playerId The ESPN player id. A negative id is a team defence, not a person.
 * @returns {?string} The URL, or null for an unsupported sport, a missing id or a negative id.
 */
export function headshotUrl(sport, playerId) {
    const base = HEADSHOT_BASE[sport];
    if (!base || playerId == null || playerId < 0) return null;
    return `${base}${playerId}.png`;
}

// The logo path is per sport, and the fantasy abbreviation is passed through unchanged.
const LOGO_SPORT_PATH = { flb: 'mlb', fhl: 'nhl', ffl: 'nfl' };

/**
 * The pro-team logo URL.
 *
 * @param {string} sport The sport key ('flb', 'fhl' or 'ffl').
 * @param {?string} abbrev The club abbreviation as the fantasy payload gives it.
 * @returns {?string} The URL, or null for an unsupported sport or a blank abbreviation.
 */
export function proTeamLogoUrl(sport, abbrev) {
    const path = LOGO_SPORT_PATH[sport];
    if (!path || !abbrev) return null;
    return `https://a.espncdn.com/i/teamlogos/${path}/500/${abbrev}.png`;
}

/**
 * Up to two initials from a name, the content of the fallback tile.
 *
 * @param {?string} name The name.
 * @returns {string} The initials, or '?' for a blank name.
 */
export function initialsFor(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A headshot over an initials tile that is already in the markup, so a missing picture never shows
 * a broken-image glyph.
 *
 * @param {string} sport The sport key.
 * @param {?number} playerId The ESPN player id.
 * @param {string} name The player's name, for the initials.
 * @returns {string} The avatar markup.
 */
export function buildPlayerAvatarHtml(sport, playerId, name) {
    const url = headshotUrl(sport, playerId);
    const tile = `<span class="avatar-initials">${escapeHtml(initialsFor(name))}</span>`;
    if (!url) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

/**
 * The pro-team logo beside a player's name, with no tile underneath.
 *
 * @param {string} sport The sport key.
 * @param {?string} abbrev The club abbreviation.
 * @returns {string} The markup, or an empty string when there is no logo to show.
 */
export function buildProTeamLogoHtml(sport, abbrev) {
    const url = proTeamLogoUrl(sport, abbrev);
    if (!url) return '';
    return `<span class="pro-team-logo"><img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

/**
 * A fantasy team's crest: its logo over a tile that prints the label as given.
 *
 * @param {?string} label The team's short form, printed verbatim in the tile.
 * @param {?string} logoUrl The league's logo URL; one that is not allowlisted is not loaded.
 * @returns {string} The crest markup.
 */
export function buildTeamCrestHtml(label, logoUrl) {
    const tile = `<span class="avatar-initials">${escapeHtml(label || '')}</span>`;
    if (!isAllowedLogoUrl(logoUrl)) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(logoUrl)}"></span>`;
}

/**
 * A pro club's crest: its logo over a tile that prints the abbreviation.
 *
 * @param {string} sport The sport key.
 * @param {?string} abbrev The club abbreviation.
 * @returns {string} The crest markup.
 */
export function buildProTeamCrestHtml(sport, abbrev) {
    const tile = `<span class="avatar-initials">${escapeHtml(abbrev || '')}</span>`;
    const url = proTeamLogoUrl(sport, abbrev);
    if (!url) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

/**
 * Names what an avatar image is for the request log, read off the URL the builders above produce.
 *
 * @param {*} src The image URL.
 * @returns {'headshot'|'pro logo'|'team logo'} The kind.
 */
export function imageKindOf(src) {
    let parsed = null;
    try { parsed = new URL(String(src)); } catch { parsed = null; }
    if (parsed && parsed.hostname === 'a.espncdn.com') {
        if (parsed.pathname.startsWith('/i/headshots/')) return 'headshot';
        if (parsed.pathname.startsWith('/i/teamlogos/')) return 'pro logo';
    }
    return 'team logo';
}

/**
 * Wires every avatar image in a container. Inline handlers are blocked on extension pages, so a
 * failed image is removed here, which uncovers the tile, and a loaded one marks its wrapper.
 *
 * @param {ParentNode} container The element to search.
 * @returns {void}
 */
export function wirePlayerAvatars(container) {
    container.querySelectorAll('img.avatar-img').forEach(img => {
        if (img.dataset.wired) return;
        img.dataset.wired = '1';
        // A request is counted when the browser reports back, not when the tag is written, because lazy images may never be fetched.
        let counted = false;
        const count = (ok) => {
            if (counted) return;
            counted = true;
            const src = img.getAttribute('src');
            countImageRequest(src, imageKindOf(src), ok);
        };
        const done = () => {
            count(true);
            img.closest('.player-avatar')?.classList.add('has-image');
        };
        if (img.complete && img.naturalWidth > 0) done();
        img.addEventListener('load', done);
        img.addEventListener('error', () => { count(false); img.remove(); });
    });
}

// Only ESPN-family hosts are loaded. A request discloses the viewer's address to the host, so anything else makes none.
const LOGO_HOST_ALLOWLIST = ['espn.com', 'espncdn.com'];

/**
 * Whether a logo URL may be loaded: https, on an ESPN-family host or a subdomain of one.
 *
 * @param {*} url The URL.
 * @returns {boolean} True when the URL is allowed.
 */
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

/**
 * The history flag's badge: a monogram, with the logo laid over it only when the host is allowed.
 *
 * @param {string} name The team name, for the monogram.
 * @param {?string} logoUrl The logo URL.
 * @returns {string} The badge markup.
 */
export function buildTeamLogoHtml(name, logoUrl) {
    const tile = `<span class="lh-flag-monogram">${escapeHtml(initialsFor(name))}</span>`;
    if (!isAllowedLogoUrl(logoUrl)) return `<span class="lh-flag-badge">${tile}</span>`;
    return `<span class="lh-flag-badge">${tile}<img class="lh-flag-logo avatar-img" loading="lazy" alt="" src="${escapeHtml(logoUrl)}"></span>`;
}
