/**
 * The Leaguewise archive: a file that outlives the extension that wrote it. Each season holds the
 * league's payloads as fetched, beside a normalised summary derived from them that a spreadsheet or
 * a script can read without knowing this repository. The format is specified in
 * tests/fixtures/archive.md.
 *
 * Pure, and it imports nothing from this repository, on purpose: an archive must be buildable and
 * readable without the app around it. So the CSV writer and the reading of a matchup side's
 * categories are copies of rules the app has elsewhere, and the summary is derived here from the
 * raw payload. No DOM, no application state, no storage and no network.
 *
 * Tests: tests/archive.test.html
 * @module archive
 */
/**
 * One season of an archive.
 *
 * @typedef {object} ArchiveSeason
 * @property {{league: object, pool: (object|undefined), weekly: (object|undefined), draft: (object|undefined), rosters: (object|undefined)}} raw The payloads as fetched.
 * @property {object} summary The normalised summary, from summarizeSeason.
 */
/**
 * An archive.
 *
 * @typedef {object} Archive
 * @property {string} schema The format's version, ARCHIVE_SCHEMA.
 * @property {string} writtenAt When the file was written, as an ISO date.
 * @property {{extensionVersion: string, sport: string, leagueId: (number|string), seasons: number[]}} provenance Where the file came from and which seasons it holds.
 * @property {Object<string, ArchiveSeason>} seasons The seasons by four-digit year.
 */

/**
 * The archive format's name and version.
 *
 * @type {string}
 */
export const ARCHIVE_SCHEMA = 'leaguewise-archive/1';

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const key = v => String(v);

// ==== The RFC 4180 writer ====

/**
 * One cell of a delimited file, by RFC 4180: quoted only when it contains the delimiter, a quote
 * or a line break, with embedded quotes doubled. Null and undefined become an empty cell.
 *
 * @param {*} value The value.
 * @param {string} [delimiter=','] The delimiter.
 * @returns {string} The cell.
 */
export function delimitedCell(value, delimiter = ',') {
    const s = (value === undefined || value === null) ? '' : String(value);
    return (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

/**
 * Builds a delimited file from a header row and data rows, with CRLF line ends as RFC 4180
 * specifies.
 *
 * @param {Array} headers The header cells.
 * @param {Array<Array>} rows The data rows.
 * @param {string} [delimiter=','] The delimiter.
 * @returns {string} The text.
 */
export function buildDelimitedText(headers, rows, delimiter = ',') {
    return [headers, ...rows]
        .map(row => row.map(cell => delimitedCell(cell, delimiter)).join(delimiter))
        .join('\r\n');
}

// ==== The normalised half, derived from the raw payload ====

// The league's own scored ids, from its scoring items. A side's own score line carries many more ids than the league scores.
function scoredIdsOf(league) {
    return ((league && league.settings && league.settings.scoringSettings
        && league.settings.scoringSettings.scoringItems) || [])
        .map(i => (i && i.statId !== undefined ? key(i.statId) : null))
        .filter(Boolean);
}

// Where the regular season ends: the period before the first one tagged as a playoff, or the scheduled count when nothing is tagged, which is every league that has not reached its bracket.
function regularSeasonPeriods(league) {
    let firstPlayoff = null;
    ((league && league.schedule) || []).forEach(g => {
        if (g && g.playoffTierType && g.playoffTierType !== 'NONE') {
            if (firstPlayoff === null || g.matchupPeriodId < firstPlayoff) firstPlayoff = g.matchupPeriodId;
        }
    });
    if (firstPlayoff !== null) return firstPlayoff - 1;
    return num(league && league.settings && league.settings.scheduleSettings
        && league.settings.scheduleSettings.matchupPeriodCount);
}

// The live block wins where both exist. The test is a real number in its wins, not mere presence, so an empty object cannot hide a good figure.
function categoriesOfSide(side, scored) {
    const live = side && side.cumulativeScoreLive;
    const tally = (live && typeof live.wins === 'number') ? live : (side && side.cumulativeScore);
    const byStat = (tally && (tally.scoreByStat || tally.statBySlot)) || {};
    const out = {};
    scored.forEach(id => {
        const entry = byStat[id];
        if (!entry) return;
        const v = Number(entry.score !== undefined ? entry.score : entry.value);
        if (Number.isFinite(v)) out[id] = v;
    });
    return out;
}

// A tie weighs half a win, which matches ESPN's own percentage. It is recomputed here, so an archive's standings rest on their own arithmetic.
function summarizeTeams(league) {
    return ((league && league.teams) || []).map(t => {
        const r = (t && t.record && t.record.overall) || {};
        const wins = num(r.wins);
        const losses = num(r.losses);
        const ties = num(r.ties);
        const games = wins + losses + ties;
        return {
            id: t.id,
            name: t.name || null,
            abbrev: t.abbrev || null,
            record: { wins, losses, ties, percentage: games > 0 ? (wins + ties / 2) / games : 0 },
            seed: t.playoffSeed === undefined ? null : num(t.playoffSeed),
            finalRank: t.rankCalculatedFinal === undefined ? null : num(t.rankCalculatedFinal)
        };
    });
}

// A bye writes no matchup. A schedule entry with one side is a team not playing, and is nobody's loss.
function summarizePeriods(league, scored) {
    const byPeriod = new Map();
    ((league && league.schedule) || []).forEach(g => {
        if (!g || !g.home || !g.away) return;
        const p = num(g.matchupPeriodId);
        if (!byPeriod.has(p)) byPeriod.set(p, []);
        const categories = {};
        const home = categoriesOfSide(g.home, scored);
        const away = categoriesOfSide(g.away, scored);
        scored.forEach(id => {
            if (home[id] === undefined && away[id] === undefined) return;
            categories[id] = { home: num(home[id]), away: num(away[id]) };
        });
        byPeriod.get(p).push({
            home: g.home.teamId,
            away: g.away.teamId,
            winner: g.winner || 'UNDECIDED',
            categories
        });
    });
    return [...byPeriod.keys()].sort((a, b) => a - b)
        .map(period => ({ period, matchups: byPeriod.get(period) }));
}

// The daily rosters, renamed to the archive's words. The slot is what tells a started player from a benched one.
function summarizeRosters(rosters) {
    if (!rosters || typeof rosters !== 'object') return undefined;
    const out = {};
    Object.keys(rosters).forEach(period => {
        const teams = rosters[period];
        if (!Array.isArray(teams)) return;
        out[key(period)] = teams.map(t => ({
            teamId: t && t.id,
            entries: ((t && t.entries) || []).map(e => ({ playerId: e && e.p, slot: e && e.slot }))
        }));
    });
    return Object.keys(out).length ? out : undefined;
}

function summarizeDraft(draft) {
    const picks = (draft && draft.draftDetail && draft.draftDetail.picks) || (draft && draft.picks);
    if (!Array.isArray(picks) || !picks.length) return undefined;
    return picks.map(p => ({
        overall: num(p.overallPickNumber !== undefined ? p.overallPickNumber : p.overall),
        round: num(p.roundId !== undefined ? p.roundId : p.round),
        teamId: p.teamId,
        playerId: p.playerId
    })).sort((a, b) => a.overall - b.overall);
}

/**
 * Derives a season's normalised summary from its raw payloads: the league's settings, each team's
 * record, every matchup by period with its categories, and the rosters and the draft where they
 * were fetched.
 *
 * @param {{league: object, rosters: (object|undefined), draft: (object|undefined)}} raw The season's payloads.
 * @returns {?{league: object, teams: object[], periods: object[], rosters: (object|undefined), draft: (object[]|undefined)}} The summary, or null with no league payload.
 */
export function summarizeSeason(raw) {
    const league = raw && raw.league;
    if (!league) return null;
    const scored = scoredIdsOf(league);
    const settings = league.settings || {};
    const summary = {
        league: {
            name: (settings.name !== undefined ? settings.name : null),
            size: num(settings.size),
            scoringType: (settings.scoringSettings && settings.scoringSettings.scoringType) || null,
            categories: scored,
            regularSeasonPeriods: regularSeasonPeriods(league),
            playoffTeamCount: num(settings.scheduleSettings && settings.scheduleSettings.playoffTeamCount)
        },
        teams: summarizeTeams(league),
        periods: summarizePeriods(league, scored)
    };
    const rosters = summarizeRosters(raw.rosters);
    if (rosters) summary.rosters = rosters;
    const draft = summarizeDraft(raw.draft);
    if (draft) summary.draft = draft;
    return summary;
}

// ==== Building one ====

/**
 * Builds an archive from each season's raw payloads. It never throws on a malformed part: a
 * missing schedule gives no periods and an absent pool stays absent. A season with no league
 * payload is left out.
 *
 * @param {object} [args]
 * @param {Object<string, object>} [args.raw] Each season's payloads, by year.
 * @param {object} [args.provenance] The extension's version, the sport and the league id.
 * @param {?string} [args.writtenAt] The time written, as an ISO date. Defaults to the present.
 * @returns {Archive} The archive.
 */
export function buildArchive({ raw = {}, provenance = {}, writtenAt = null } = {}) {
    const seasons = {};
    Object.keys(raw).sort().forEach(year => {
        const parts = raw[year] || {};
        // A season with no league payload is skipped, since the summary is derived from it.
        const summary = summarizeSeason(parts);
        if (!summary) return;
        // The weekly slot is stored as handed in, and nothing is derived from it.
        const kept = {};
        ['league', 'pool', 'weekly', 'draft', 'rosters'].forEach(slot => {
            if (parts[slot] !== undefined) kept[slot] = parts[slot];
        });
        seasons[key(year)] = { raw: kept, summary };
    });

    return {
        schema: ARCHIVE_SCHEMA,
        writtenAt: writtenAt || new Date().toISOString(),
        provenance: {
            ...provenance,
            // Filled from what was written, so the header cannot disagree with the body. Whatever the caller passed for this field is replaced.
            seasons: Object.keys(seasons).map(y => num(y)).sort((a, b) => a - b)
        },
        seasons
    };
}

// ==== The gate ====

// A key matching one of these, at any depth of the provenance, in any case, fails the gate. An archive is the one file that leaves the browser, so this is a check and not a convention.
const SECRET_KEYS = /^(swid|cookie|cookies|token|authtoken|memberid|espn_s2|s2)$/i;

function findSecret(value, path) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const hit = findSecret(value[i], `${path}[${i}]`);
            if (hit) return hit;
        }
        return null;
    }
    for (const k of Object.keys(value)) {
        if (SECRET_KEYS.test(k)) return `${path}.${k}`;
        const hit = findSecret(value[k], `${path}.${k}`);
        if (hit) return hit;
    }
    return null;
}

const YEAR = /^\d{4}$/;

/**
 * Checks an archive against the format. It fails on a wrong schema, a date that does not parse,
 * missing provenance, a season with no league payload or no summary, a list of seasons that
 * disagrees with the seasons held, and any key in the provenance that names a session id, a
 * cookie, a token or a member id.
 *
 * @param {*} archive The parsed file.
 * @returns {{ok: boolean, issues: Array<{path: string, why: string}>}} Valid only with no issues.
 */
export function validateArchive(archive) {
    const issues = [];
    const add = (path, why) => issues.push({ path, why });
    const a = archive || {};

    if (a.schema !== ARCHIVE_SCHEMA) add('schema', `must be exactly "${ARCHIVE_SCHEMA}"`);
    if (!a.writtenAt || Number.isNaN(Date.parse(a.writtenAt))) add('writtenAt', 'must be a date that parses');

    const p = a.provenance;
    if (!p || typeof p !== 'object') {
        add('provenance', 'missing');
    } else {
        ['extensionVersion', 'sport', 'leagueId'].forEach(f => {
            if (p[f] === undefined || p[f] === null || p[f] === '') add(`provenance.${f}`, 'missing');
        });
        const secret = findSecret(p, 'provenance');
        if (secret) add(secret, 'an archive never carries a SWID, a cookie, a token or a member id');
    }

    const seasons = a.seasons;
    if (!seasons || typeof seasons !== 'object' || Array.isArray(seasons) || !Object.keys(seasons).length) {
        add('seasons', 'must be an object with at least one year');
    } else {
        Object.keys(seasons).forEach(y => {
            if (!YEAR.test(y)) add(`seasons.${y}`, 'must be a four-digit year');
            const s = seasons[y] || {};
            if (!s.raw || !s.raw.league) add(`seasons.${y}.raw.league`, 'missing');
            if (!s.summary) add(`seasons.${y}.summary`, 'missing');
        });
        if (p && typeof p === 'object') {
            const declared = (Array.isArray(p.seasons) ? p.seasons : []).map(key).sort().join(',');
            const actual = Object.keys(seasons).sort().join(',');
            if (declared !== actual) {
                add('provenance.seasons', `says ${declared || '(none)'} but the file holds ${actual}`);
            }
        }
    }
    // Valid means no issues at all.
    return { ok: issues.length === 0, issues };
}

// ==== Merging a re-export ====

/**
 * Puts one season into an archive, replacing that year whole and leaving every other year as it
 * was. A re-export of a year is the better copy of it; two payloads merged field by field would
 * make a season that never existed.
 *
 * @param {?Archive} archive The archive so far.
 * @param {number|string} year The season's year.
 * @param {?ArchiveSeason} season The season, or null to remove the year.
 * @param {?string} [writtenAt] The time written. Defaults to the present.
 * @returns {Archive} A new archive, so a failed merge cannot damage the one passed in.
 */
export function mergeSeason(archive, year, season, writtenAt = null) {
    const base = archive && typeof archive === 'object' ? archive : {};
    const seasons = { ...(base.seasons || {}) };
    if (season === null || season === undefined) delete seasons[key(year)];
    else seasons[key(year)] = season;

    const years = Object.keys(seasons).map(y => num(y)).sort((a, b) => a - b);
    return {
        ...base,
        schema: base.schema || ARCHIVE_SCHEMA,
        writtenAt: writtenAt || new Date().toISOString(),
        provenance: { ...(base.provenance || {}), seasons: years },
        seasons
    };
}

// ==== CSV ====

/**
 * One table of one season as CSV: 'standings', 'draft' or 'categories'. The categories table has
 * one row per side of each matchup.
 *
 * @param {Archive} archive The archive.
 * @param {number|string} year The season's year.
 * @param {string} table The table's name.
 * @returns {string} The CSV. Empty for an unknown table, a missing year, or a draft that was not fetched.
 */
export function csvOf(archive, year, table) {
    const season = archive && archive.seasons && archive.seasons[key(year)];
    const summary = season && season.summary;
    if (!summary) return '';

    if (table === 'standings') {
        return buildDelimitedText(
            ['Team', 'Abbrev', 'W', 'L', 'T', 'Pct', 'Seed', 'Final rank'],
            (summary.teams || []).map(t => [
                t.name, t.abbrev, t.record.wins, t.record.losses, t.record.ties,
                t.record.percentage, t.seed, t.finalRank
            ])
        );
    }

    if (table === 'draft') {
        if (!summary.draft) return '';
        return buildDelimitedText(
            ['Overall', 'Round', 'Team', 'Player'],
            summary.draft.map(p => [p.overall, p.round, p.teamId, p.playerId])
        );
    }

    if (table === 'categories') {
        const cats = (summary.league && summary.league.categories) || [];
        const nameOf = new Map((summary.teams || []).map(t => [key(t.id), t.name]));
        const rows = [];
        // One row per side, which is what a spreadsheet wants. The matchup is kept whole in the summary and flattened here.
        (summary.periods || []).forEach(p => {
            (p.matchups || []).forEach(m => {
                [['home', 'away'], ['away', 'home']].forEach(([me, them]) => {
                    const result = m.winner === 'TIE' ? 'Tie'
                        : (m.winner === me.toUpperCase() ? 'Win'
                            : (m.winner === 'UNDECIDED' ? '' : 'Loss'));
                    rows.push([
                        p.period, nameOf.get(key(m[me])) || m[me], nameOf.get(key(m[them])) || m[them], result,
                        ...cats.map(id => (m.categories[id] ? m.categories[id][me] : ''))
                    ]);
                });
            });
        });
        return buildDelimitedText(['Period', 'Team', 'Opponent', 'Result', ...cats], rows);
    }

    return '';
}
