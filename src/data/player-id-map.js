/**
 * Decides which player in an external source is which ESPN player.
 *
 * There is no shared key. ESPN's fantasy payload carries no external id and no date of birth, so a
 * player has to be recognised by name, and a name is a weak key. The rule that follows is the
 * whole design: when in doubt, do not match. An unmatched player is a visible gap, while a wrong
 * match hands one player's season to another and nothing downstream can detect it. Every tier of
 * the ladder refuses before it guesses.
 *
 * Pure. No DOM, no application state and no network; fetching lives elsewhere.
 *
 * Tests: tests/features.test.html
 * @module player-id-map
 */

// ==== Name normalization ====

/**
 * Reduces a name to a comparable form: lower case, accents and punctuation removed, a
 * generational suffix dropped, spaces collapsed. It does not map nicknames, since a wrong entry in
 * a nickname list is a wrong match.
 *
 * @param {string} name The name.
 * @returns {string} The normalized name, empty for none.
 */
export function normalizeName(name) {
    if (!name && name !== 0) return '';
    return String(name)
        .toLowerCase()
        .normalize('NFD')
        // Combining marks are stripped, so an accented name matches however either source spells it. The range is written as escapes because the characters themselves are invisible in a source file.
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.'\u2019\-]/g, '')
        // Generational suffixes are stripped only at the end of the name, so a surname that contains the same letters keeps them.
        .replace(/\s+(jr|sr|ii|iii|iv)$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The variant tier's key: last name plus first initial, from the normalized name.
 *
 * @param {string} name The name.
 * @returns {string} The key, or empty for a name of one word.
 */
export function nameVariantKey(name) {
    const parts = normalizeName(name).split(' ').filter(Boolean);
    if (parts.length < 2) return '';
    return `${parts[parts.length - 1]} ${parts[0][0]}`;
}

// ==== The club tables ====

/**
 * ESPN's pro team id to the external league's own key for the club, per sport. It is a table and
 * not a comparison of abbreviations, because ESPN's abbreviations differ from the league's own for
 * many clubs. It was built by joining real rosters, not from the clubs' names.
 *
 * ESPN's free-agent pseudo-club, id 0, has no entry, so a lookup for it finds no club.
 *
 * @type {Object<string, Object<number, {espnAbbrev: string, nhlTriCode: string}>>}
 */
export const PROTEAM_CLUB_MAP = {
    fhl: {
        1: { espnAbbrev: 'Bos', nhlTriCode: 'BOS' },
        2: { espnAbbrev: 'Buf', nhlTriCode: 'BUF' },
        3: { espnAbbrev: 'Cgy', nhlTriCode: 'CGY' },
        4: { espnAbbrev: 'Chi', nhlTriCode: 'CHI' },
        5: { espnAbbrev: 'Det', nhlTriCode: 'DET' },
        6: { espnAbbrev: 'Edm', nhlTriCode: 'EDM' },
        7: { espnAbbrev: 'Car', nhlTriCode: 'CAR' },
        8: { espnAbbrev: 'LA', nhlTriCode: 'LAK' },
        9: { espnAbbrev: 'Dal', nhlTriCode: 'DAL' },
        10: { espnAbbrev: 'Mon', nhlTriCode: 'MTL' },
        11: { espnAbbrev: 'NJ', nhlTriCode: 'NJD' },
        12: { espnAbbrev: 'NYI', nhlTriCode: 'NYI' },
        13: { espnAbbrev: 'NYR', nhlTriCode: 'NYR' },
        14: { espnAbbrev: 'Ott', nhlTriCode: 'OTT' },
        15: { espnAbbrev: 'Phi', nhlTriCode: 'PHI' },
        16: { espnAbbrev: 'Pit', nhlTriCode: 'PIT' },
        17: { espnAbbrev: 'Col', nhlTriCode: 'COL' },
        18: { espnAbbrev: 'SJ', nhlTriCode: 'SJS' },
        19: { espnAbbrev: 'StL', nhlTriCode: 'STL' },
        20: { espnAbbrev: 'TB', nhlTriCode: 'TBL' },
        21: { espnAbbrev: 'Tor', nhlTriCode: 'TOR' },
        22: { espnAbbrev: 'Van', nhlTriCode: 'VAN' },
        23: { espnAbbrev: 'Wsh', nhlTriCode: 'WSH' },
        25: { espnAbbrev: 'Ana', nhlTriCode: 'ANA' },
        26: { espnAbbrev: 'Fla', nhlTriCode: 'FLA' },
        27: { espnAbbrev: 'Nsh', nhlTriCode: 'NSH' },
        28: { espnAbbrev: 'Wpg', nhlTriCode: 'WPG' },
        29: { espnAbbrev: 'CBJ', nhlTriCode: 'CBJ' },
        30: { espnAbbrev: 'Min', nhlTriCode: 'MIN' },
        37: { espnAbbrev: 'VGK', nhlTriCode: 'VGK' },
        124292: { espnAbbrev: 'Sea', nhlTriCode: 'SEA' },
        129764: { espnAbbrev: 'UTA', nhlTriCode: 'UTA' }
    },
    // Baseball is empty on purpose. No table is built against a source until that source's terms have been read and recorded.
    flb: {}
};

/**
 * The external source's key for the club an ESPN pro team id names.
 *
 * @param {string} sport The sport key.
 * @param {number|string} proTeamId ESPN's pro team id.
 * @param {string} [key='nhlTriCode'] Which of the row's keys to return.
 * @returns {?string} The club key, or null when there is none.
 */
export function clubOf(sport, proTeamId, key = 'nhlTriCode') {
    const row = (PROTEAM_CLUB_MAP[sport] || {})[Number(proTeamId)];
    return (row && row[key]) || null;
}

// ==== Hand-maintained tables ====

// These win over every tier below. Each row carries a comment saying why it is there.
const MANUAL_ID_OVERRIDES = {
    fhl: {
    },
    flb: {}
};

/**
 * ESPN ids known to be duplicates of another entry, per sport, each with the reason. They are not
 * matched and are not counted as failures: an entry that is not a player is not a player who
 * failed to match.
 *
 * @type {Object<string, Object<number, string>>}
 */
export const DEAD_ENTRIES = {
    fhl: {
        // One player ESPN carries under two ids. Both are listed, since which one is stale depends on the capture. An id found in the crosswalk is matched all the same, since the crosswalk is read first.
        5393: 'ESPN carries Andrew Agozzino under two ids on one club; this is one of them',
        2486992: 'ESPN carries Andrew Agozzino under two ids on one club; this is the other'
    },
    flb: {}
};

// ESPN id to external id, compiled per release and shipped in the module. It is empty until an external source may be read, and the ladder works without it. Ids are stable on both sides, so the table only grows.
const ID_CROSSWALK = { fhl: {}, flb: {} };

// ==== The ladder ====

const MATCH_TIERS = ['crosswalk', 'override', 'name+club', 'jersey', 'unique-name', 'variant'];

function indexBy(list, keyOf) {
    const map = new Map();
    (list || []).forEach(item => {
        const key = keyOf(item);
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    });
    return map;
}

/**
 * Matches one pool against another, one decision per ESPN player. The tiers run in order: the
 * compiled crosswalk, the hand overrides, name plus club, jersey as a tie-break, a name unique
 * across the league, and last name plus initial within the club. A player no tier settles is
 * left unmatched, with the reason.
 *
 * @param {object} [args]
 * @param {string} args.sport The sport key.
 * @param {Array<{id: number, fullName: string, proTeamId: number, jersey: *}>} args.espnPlayers ESPN's players.
 * @param {Array<{id: *, fullName: string, club: string, jersey: *}>} args.externalPlayers The external source's players, each with this sport's club key.
 * @param {Object<number, *>} [args.crosswalk] ESPN id to external id. Defaults to the module's own.
 * @param {Object<number, *>} [args.overrides] Hand overrides. Defaults to the module's own.
 * @param {Object<number, string>} [args.dead] Dead entries. Defaults to the module's own.
 * @returns {{matched: Array<{espnId: number, externalId: *, tier: string, name: string}>, unmatched: Array<{espnId: number, name: string, reason: string}>, dropped: Array<{espnId: number, name: string, reason: string}>}}
 *   The matches with the tier that decided each, the refusals, and the dead entries set aside.
 */
export function matchPlayers({ sport, espnPlayers, externalPlayers, crosswalk, overrides, dead } = {}) {
    const cross = crosswalk || (ID_CROSSWALK[sport] || {});
    const manual = overrides || (MANUAL_ID_OVERRIDES[sport] || {});
    const ghosts = dead || (DEAD_ENTRIES[sport] || {});
    const ext = (externalPlayers || []).map(p => ({
        ...p, norm: normalizeName(p.fullName), variant: nameVariantKey(p.fullName)
    }));

    const byNameClub = indexBy(ext, p => p.norm && p.club ? `${p.norm}|${p.club}` : '');
    const byName = indexBy(ext, p => p.norm);
    const byVariantClub = indexBy(ext, p => p.variant && p.club ? `${p.variant}|${p.club}` : '');

    // The ESPN side is indexed once too, so asking whether anyone else shares a name is a lookup and not a scan.
    const own = (espnPlayers || []).map(p => ({
        p, norm: normalizeName(p.fullName), variant: nameVariantKey(p.fullName), club: clubOf(sport, p.proTeamId)
    }));
    const ownByNameClub = indexBy(own, o => o.norm && o.club ? `${o.norm}|${o.club}` : '');
    const ownByName = indexBy(own, o => o.norm);
    const ownByVariantClub = indexBy(own, o => o.variant && o.club ? `${o.variant}|${o.club}` : '');
    const others = (index, key, id) => (index.get(key) || []).filter(o => o.p.id !== id).length;

    const matched = [];
    const unmatched = [];
    const dropped = [];

    (espnPlayers || []).forEach(p => {
        const name = p.fullName;
        const norm = normalizeName(name);
        const club = clubOf(sport, p.proTeamId);

        // 1. The compiled crosswalk. An id decided once is not decided again each season by a name comparison.
        if (cross[p.id] !== undefined && cross[p.id] !== null) {
            matched.push({ espnId: p.id, externalId: cross[p.id], tier: 'crosswalk', name });
            return;
        }
        // 2. Hand overrides, above everything a name can decide.
        if (manual[p.id] !== undefined && manual[p.id] !== null) {
            matched.push({ espnId: p.id, externalId: manual[p.id], tier: 'override', name });
            return;
        }
        // A known dead entry is set aside before the name tiers, so it never competes with the real player and never appears among the failures.
        if (ghosts[p.id]) {
            dropped.push({ espnId: p.id, name, reason: ghosts[p.id] });
            return;
        }

        // 3. Name plus club, unique on both sides. Unique on the external side alone is not enough: two ESPN players sharing a name on one club would both claim the same external player.
        if (club) {
            const key = `${norm}|${club}`;
            const cands = byNameClub.get(key) || [];
            if (cands.length === 1 && !others(ownByNameClub, key, p.id)) {
                matched.push({ espnId: p.id, externalId: cands[0].id, tier: 'name+club', name });
                return;
            }
            // 4. Jersey, only to break a tie the tier above could not. It is never a first key, since some players have no number and numbers change on trades. If the numbers do not single one out, the player is refused.
            if (cands.length > 1) {
                const byJersey = p.jersey ? cands.filter(c => String(c.jersey) === String(p.jersey)) : [];
                if (byJersey.length === 1) {
                    matched.push({ espnId: p.id, externalId: byJersey[0].id, tier: 'jersey', name });
                } else {
                    unmatched.push({
                        espnId: p.id, name,
                        reason: `${cands.length} external players share this name on ${club}` +
                            (p.jersey ? ` and jersey ${p.jersey} does not single one out` : ' and this player has no jersey')
                    });
                }
                return;
            }
        }

        // 5. A name unique across the whole league, on both sides. This catches a player with no club to join on, and the days when the two sources disagree about where a player plays.
        const sameName = byName.get(norm) || [];
        if (sameName.length === 1 && !others(ownByName, norm, p.id)) {
            matched.push({ espnId: p.id, externalId: sameName[0].id, tier: 'unique-name', name });
            return;
        }

        // 6. The variant: last name plus first initial, within the club. It recovers a shortened first name. It is last and scoped to the club because a surname and an initial is a weak key, and it refuses when two players share it.
        if (club) {
            const vk = `${nameVariantKey(name)}|${club}`;
            const cands = byVariantClub.get(vk) || [];
            if (cands.length === 1 && !others(ownByVariantClub, vk, p.id)) {
                matched.push({ espnId: p.id, externalId: cands[0].id, tier: 'variant', name });
                return;
            }
        }

        // 7. Never guess.
        unmatched.push({
            espnId: p.id, name,
            reason: club
                ? `no external player matches this name on ${club}`
                : 'no club to join on, and the name is not unique league-wide'
        });
    });

    return { matched, unmatched, dropped };
}

/**
 * A summary of a match run: the totals, the rate, and the count per tier. Dead entries are left
 * out of the total.
 *
 * @param {{matched: object[], unmatched: object[], dropped: object[]}} result A result from matchPlayers.
 * @returns {{total: number, matched: number, unmatched: number, dropped: number, rate: number, byTier: Object<string, number>}} The summary.
 */
export function matchSummary(result) {
    const matched = (result && result.matched) || [];
    const unmatched = (result && result.unmatched) || [];
    const total = matched.length + unmatched.length;
    const byTier = {};
    MATCH_TIERS.forEach(t => { byTier[t] = matched.filter(m => m.tier === t).length; });
    return {
        total,
        matched: matched.length,
        unmatched: unmatched.length,
        dropped: ((result && result.dropped) || []).length,
        rate: total ? matched.length / total : 0,
        byTier
    };
}
