// Player imagery, shared plumbing, in its own module because the leaderboard and the drill-down adopt the same helpers later. PRIVACY BOUNDARY: these are the only requests the extension makes outside ESPN's fantasy API, and they go to ESPN's own image CDN. An image request sends nothing but the URL, which carries a public athlete id and no league, team or account identifier.

import { escapeHtml } from './utils.js';

// Validated against real player ids from captured payloads by loading each URL and confirming it decodes, in both sports. An invalid id fires the image's error event rather than serving a placeholder, which is what makes the fallback tile below reachable. The fantasy playerId IS the athlete id in this path, so nothing needs translating.
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

// The avatar cell: a lazy-loading headshot over an initials tile that is already in the markup. The tile shows until the image decodes, so a missing headshot, an offline preview and a slow network all look the same and none of them shows a broken-image glyph.
export function buildPlayerAvatarHtml(sport, playerId, name) {
    const url = headshotUrl(sport, playerId);
    const tile = `<span class="avatar-initials">${escapeHtml(initialsFor(name))}</span>`;
    if (!url) return `<span class="player-avatar">${tile}</span>`;
    return `<span class="player-avatar">${tile}<img class="avatar-img" loading="lazy" alt="" src="${escapeHtml(url)}"></span>`;
}

// Extension pages run under a CSP that blocks inline handlers, so the error path is wired here rather than with an onerror attribute. A failed image is removed outright, which uncovers the tile underneath, and a loaded one marks its wrapper so the tile hides.
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
