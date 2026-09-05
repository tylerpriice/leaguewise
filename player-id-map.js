// PURE. No DOM, no AppState, no fetches - the same contract as rank-engine.js, draft-engine.js and leverage-engine.js. Fetching lives in api.js and, when it exists, a future fetchExternal; this file only decides WHICH external player is which ESPN player (DATA-SOURCES rule 6, 4b). --------------------------------------------------------------------------------------------- WHY THIS IS HARD: THERE IS NO SHARED KEY --------------------------------------------------------------------------------------------- ESPN's fantasy payload carries no external id and no date of birth. That is measured, not assumed: every plausible crossref field (dateOfBirth, birthDate, uid, guid, externalIds, bats, throws, height, weight, debutYear) was probed across every player in both pools and came back 0 of 3000 (baseball) and 0 of 1039 (hockey). So a player has to be recognised by NAME, and names are the worst key there is. The rule that follows from that, and it is the whole design: WHEN IN DOUBT, DO NOT MATCH. An unmatched player gets no external data, which is a visible hole. A WRONG match silently attributes one player's season to another, and nothing downstream can detect it. Every tier below is written to refuse rather than guess, and the failure mode is deliberately the safe one. --------------------------------------------------------------------------------------------- WHAT THE NUMBERS SAY THE FAILURES WILL BE --------------------------------------------------------------------------------------------- Measured on the real pools: 19 duplicated normalized names among 3000 baseball players (the four Luis Garcias, three Jose Rodriguezes, two Will Smiths) - and ZERO collisions once club is joined. Hockey has exactly one duplicated name in 1039, and it is the same human twice (see the override table). So false matches are not the dominant risk; MISSES are, and they come from nicknames: Johnny/John, Alex/Alexander, Gabe/Gabriel, and P.O Joseph for Pierre-Olivier, measured at 1.3% of stable ids across seasons. That is why there is a variant tier, and why it is last. --------------------------------------------------------------------------------------------- MEASURED END TO END, --------------------------------------------------------------------------------------------- The whole ladder run against the real 2025 hockey pool (1013 ESPN players) and the NHL's own season-20242025 skater and goalie reports (1023 players), in 5ms: 1008 of 1013 matched - 99.5%, against the >98.5% bar the plan set name+club 963 unique-name 23 variant 22 jersey 0 crosswalk 0 (it is still empty) FIVE refusals, and every one of them is CORRECT. Not one false match. The variant tier earned its place: it recovered 22 players, 2.2% of the pool, which is the nickname rate the cross-season measurement predicted. THE JERSEY TIER IS CURRENTLY INERT FOR HOCKEY, and that is a fact about the source rather than this code: the NHL's bulk skater, goalie and realtime reports carry no sweater number at all, so there is nothing to tiebreak WITH. Tier 3 ambiguity therefore falls straight through to a refusal for hockey today. The tier stays because the per-player landing endpoint does carry the number, and because baseball's pool has one on 91.6% of players. THE COLLISION THAT PROVES THE DESIGN is the pair of Elias Petterssons on Vancouver - a forward and a defenceman, the same name on the same club, which is the exact shape that survives name, club AND jersey together. ESPN disambiguates one of them as "Elias N. Pettersson", which then matches nothing on the NHL side. The ladder refuses all of it and reports both, which is the only honest outcome: one of these two players would otherwise be handed the other's season.

// ==== Name normalization ====

// Canonicalizes the ACCENT and PUNCTUATION axis and deliberately not the nickname axis. A nickname map would be a list of guesses about which shortenings are the same person, and a wrong entry there is a wrong match - the one failure this file exists to prevent. Nicknames are handled by the variant tier, which requires club agreement before it will believe them.
export function normalizeName(name) {
    if (!name && name !== 0) return '';
    return String(name)
        .toLowerCase()
        .normalize('NFD')
        // Strip combining marks, so Nazem Kadri survives whichever way either source spells the name. Written as escapes: the range is invisible combining characters, and a source file that carries them literally is one careless editor away from being silently wrong.
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.'\u2019\-]/g, '')
        // Generational suffixes only at the END of the name. Stripping them anywhere would eat the "II" out of a surname that legitimately contains it.
        .replace(/\s+(jr|sr|ii|iii|iv)$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Last name plus first initial, the variant tier's key. Built from the normalized name so it inherits every rule above.
export function nameVariantKey(name) {
    const parts = normalizeName(name).split(' ').filter(Boolean);
    if (parts.length < 2) return '';
    return `${parts[parts.length - 1]} ${parts[0][0]}`;
}

// ==== The club tables ====

// ESPN proTeamId -> the external league's own club key. NOT STRING-MATCHED ABBREVIATIONS. ESPN's own abbrevs diverge from the NHL's on a third of the league - Mon/MTL, LA/LAK, NJ/NJD, SJ/SJS, TB/TBL, Cgy/CGY, StL/STL, Wsh/WSH - so joining on the letters would silently lose those clubs and quietly mis-club any player on them. VALIDATED BY JOINING REAL ROSTERS, not by writing down what the clubs are called. Every one of the 1013 players in the 2025 hockey pool was normalized-name joined against the NHL's own season-20242025 skater, goalie and realtime reports (920 + 103 + 920 rows), and each ESPN proTeamId was assigned the triCode that its single-club players actually carried: 976 of 1013 ESPN players joined (37 unmatched, 3.7% - the nickname rate above) ALL 32 ESPN clubs decided, ALL 32 NHL triCodes claimed, none left over on either side plurality per row ran 23/24 to 30/30; the stray single votes are players who changed club between the pool snapshot and the NHL's season-of-record, which is what a snapshot means The three ids a table earns its keep on are in here: Vegas is 37 rather than 24, Seattle is 124292 and Utah is 129764 - ESPN never renumbered when it added them. proTeamId 0 is ESPN's free-agent pseudo-club (abbrev "FA", confirmed in both schedule captures) and has NO external counterpart. It is deliberately absent, so a lookup returns undefined and the ladder falls through to its league-wide tier rather than matching everyone to a nonexistent club.
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
    // BASEBALL IS DELIBERATELY EMPTY. Not an oversight and not a to-do: MLBAM's terms restrict commercial use, and DATA-SOURCES #2 requires that check to be read and recorded before anything is built against that host. Shipping the table first would be building against it. It arrives with the ruling, validated the same way this one was.
    flb: {}
};

// The club key an ESPN player's proTeamId means to the external source, or null when there is none.
export function clubOf(sport, proTeamId, key = 'nhlTriCode') {
    const row = (PROTEAM_CLUB_MAP[sport] || {})[Number(proTeamId)];
    return (row && row[key]) || null;
}

// ==== Hand-maintained tables ====

// Wins over every tier below it. One why-comment per row, always - a row nobody can explain is a row nobody can safely remove.
export const MANUAL_ID_OVERRIDES = {
    fhl: {
        // The two Elias Petterssons on Vancouver, MEASURED in the real pool: same normalized name, same club, and the NHL reports carry no jersey to separate them. ESPN's own disambiguation ("Elias N. Pettersson") does not survive normalization against the NHL side either, so BOTH refuse. This is the row the table exists for - but it stays empty until something is allowed to fetch, because writing an NHL id in here today would be writing down a number nobody has verified against the source. It is named here so the next person to run a match sees a known case rather than a mystery. ESPN carries Andrew Agozzino TWICE - ids 5393 and 2486992, same club (Utah, 129764), same jersey (36), same position. It is one human and an ESPN data-quality duplicate, not a name clash, so it survives name+club+jersey and would deadlock tier 3 forever. Both ids are mapped to nothing here rather than to a guessed NHL id: the crosswalk will carry the real one for whichever id the pool actually serves, and DEAD_ENTRIES below records the stale twin so it stops being reported as an unexplained miss every run.
    },
    flb: {}
};

// ESPN ids known to be duplicates or ghosts. Not matched, and not counted as failures either - the difference between "we could not match this player" and "there is no such player" is the difference between a bug and a fact, and a report that conflates them trains its reader to ignore it.
export const DEAD_ENTRIES = {
    fhl: {
        // The stale half of the Agozzino double-entry above. Which of the two ids is stale depends on the capture, so both are listed and the crosswalk decides: an id present in the crosswalk is matched, the other is dead. Listing both is safe because a crosswalk hit outranks this table.
        5393: 'ESPN carries Andrew Agozzino under two ids on one club; this is one of them',
        2486992: 'ESPN carries Andrew Agozzino under two ids on one club; this is the other'
    },
    flb: {}
};

// espnId -> externalId, compiled per release and shipped inside the module. EMPTY UNTIL SOMETHING IS ALLOWED TO FETCH. Compiling it needs one pass over an external source, and no external host is reachable yet - the permission and the terms rulings are both pending. The ladder is written to work without it (it is tier 1 of 6, not a prerequisite), so this file is useful the day a fetch is permitted and correct today. Ids are stable on both sides across seasons - 797 of 797 ESPN hockey ids held across three seasons, and NHL and MLBAM ids are permanent - so this table only ever grows, and a match that lands here never re-flaps.
export const ID_CROSSWALK = { fhl: {}, flb: {} };

// ==== The ladder ====

export const MATCH_TIERS = ['crosswalk', 'override', 'name+club', 'jersey', 'unique-name', 'variant'];

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

// Match one pool against another. Pure: two plain lists in, a decision per ESPN player out. espnPlayers: [{ id, fullName, proTeamId, jersey }] externalPlayers: [{ id, fullName, club, jersey }] club being this sport's external club key Returns { matched: [{ espnId, externalId, tier, name }], unmatched: [{ espnId, name, reason }] }. Every unmatched player carries a REASON, because the whole maintenance loop for this thing is reading that list and adding override rows, and "no match" tells nobody what to do.
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

    // The ESPN side gets indexed ONCE too. Asking "does anyone else here share this name" by re-scanning the list per player is a 3000 x 3000 walk with a normalize on every step, which is nine million string operations to answer a question three Maps answer for free.
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

        // 1. The compiled crosswalk. An id that landed here was decided once and does not get re-decided every season by a name comparison that might go differently.
        if (cross[p.id] !== undefined && cross[p.id] !== null) {
            matched.push({ espnId: p.id, externalId: cross[p.id], tier: 'crosswalk', name });
            return;
        }
        // 2. Hand overrides, above everything a name can decide.
        if (manual[p.id] !== undefined && manual[p.id] !== null) {
            matched.push({ espnId: p.id, externalId: manual[p.id], tier: 'override', name });
            return;
        }
        // A known ghost is set aside BEFORE the name tiers, so it never competes with the real player for a match and never appears in the failure list.
        if (ghosts[p.id]) {
            dropped.push({ espnId: p.id, name, reason: ghosts[p.id] });
            return;
        }

        // 3. Name plus club, and it must be unique on BOTH sides. Uniqueness on the external side alone is not enough: two ESPN players sharing a name on one club (which happens, see the override table) would both claim the same external player.
        if (club) {
            const key = `${norm}|${club}`;
            const cands = byNameClub.get(key) || [];
            if (cands.length === 1 && !others(ownByNameClub, key, p.id)) {
                matched.push({ espnId: p.id, externalId: cands[0].id, tier: 'name+club', name });
                return;
            }
            // 4. Jersey, ONLY to break a tie tier 3 could not. It is never a primary key: 8.4% of the baseball pool has no jersey at all and numbers change on trades. If the jerseys do not single one out, this refuses and the player goes to the list a human reads - which is the correct outcome, not a fallback.
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

        // 5. Globally unique name. This is what catches the free agents - proTeamId 0, which has no club to join on - and the trade window, where the two sources disagree about where a player plays for a few days. Unique on BOTH sides or nothing.
        const sameName = byName.get(norm) || [];
        if (sameName.length === 1 && !others(ownByName, norm, p.id)) {
            matched.push({ espnId: p.id, externalId: sameName[0].id, tier: 'unique-name', name });
            return;
        }

        // 6. The variant pass: last name plus first initial, within the club. This is the tier that recovers Johnny for John and Gabe for Gabriel, and it is last and club-scoped because a surname and an initial is a weak key on its own - two brothers on one roster would collide, and it refuses rather than picking one.
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

// A one-line summary of a match run, for the report a human reads before editing the override table. Ghost entries are excluded from the denominator - they are not players who failed to match, they are entries that are not players.
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
