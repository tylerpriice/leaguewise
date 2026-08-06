// Player imagery, shared plumbing. My Team is the first surface to use it; the leaderboard and the drill-down adopt the same helpers later (B8/), which is why this lives in its own module rather than inside players.js. PRIVACY BOUNDARY. These are the only requests the extension makes outside ESPN's fantasy API. An image request sends nothing but the URL, which carries a public athlete id and no league, team or account identifier. Recorded as a Decision in ROADMAP.md, and the privacy copy in the README and both store listings is amended in the same release.

import { escapeHtml } from './utils.js';

// VALIDATED against real player ids taken from captured payloads, by loading each URL and confirming it decodes (600x436 in both sports): flb 39832 Shohei Ohtani, 4917694 Elly De La Cruz fhl 4063433 Alex DeBrincat, 3041969 Nathan MacKinnon A deliberately invalid id (99999999) fires the image's error event rather than serving a placeholder, which is what makes the fallback tile below reachable and worth having. The fantasy playerId IS the athlete id in this path; nothing needs translating.
const HEADSHOT_BASE = {
    flb: 'https://a.espncdn.com/i/headshots/mlb/players/full/',
    fhl: 'https://a.espncdn.com/i/headshots/nhl/players/full/'
};

// Null for an unsupported sport or a missing id, so callers render the fallback tile instead of requesting a URL that cannot resolve.
export function headshotUrl(sport, playerId) {
    const base = HEADSHOT_BASE[sport];
    if (!base || playerId == null) return null;
    return `${base}${playerId}.png`;
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

// Extension pages run under a CSP that blocks inline handlers, so the error path is wired here rather than with an onerror attribute. A failed image is removed outright, which uncovers the tile underneath; a loaded one marks its wrapper so the tile hides.
export function wirePlayerAvatars(container) {
    container.querySelectorAll('img.avatar-img').forEach(img => {
        if (img.dataset.wired) return;
        img.dataset.wired = '1';
        const done = () => img.closest('.player-avatar')?.classList.add('has-image');
        if (img.complete && img.naturalWidth > 0) done();
        img.addEventListener('load', done);
        img.addEventListener('error', () => img.remove());
    });
}
