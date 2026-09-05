// League History's math. PURE - no DOM, no AppState, no fetches - for the same reason rank-engine.js is: it is the only way any of this gets a unit test, and every number here is summed across seasons where a mistake is invisible by inspection. VALIDATED against three real seasons of one league before a line was written (docs/DATA-SOURCES.md section 9). Three measurements shaped everything below: 1. primaryOwner SWID survives across seasons, team NAMES do not. One franchise read "RIP Wolves", then "Crease Crashers", then "Ice Wolves". 2. teamId is not a franchise. Slot 4 was one person in 2024-25 and a different person in 2026, so keying on it would merge two managers into one row. 3. FORMAT DRIFT: the same league was ROTO for two seasons then H2H categories. A roto season has no W-L-T and no matchups at all, so anything counting games has to know which seasons it is allowed to count and say so.

// ESPN writes the SWID braced and cased inconsistently between payloads, the same reason recap.js and myteam.js normalize before comparing.
function normSwid(v) {
    return String(v || '').replace(/[{}]/g, '').toUpperCase();
}

// The franchise key. SWID when there is one, teamId only as the fallback the measurement says is unsafe to prefer - a season with no ownership data is the only case it should ever answer for, and it is prefixed so it can never collide with a real SWID.
export function franchiseKeyOf(team) {
    const swid = normSwid(team && (team.primaryOwner || (team.owners || [])[0]));
    if (swid) return swid;
    const id = team && team.id;
    return id === null || id === undefined ? null : `team:${id}`;
}

// The league's own abbreviation, with data.js's fallback for a team that never set one: the first four characters of its name, uppercased. Kept identical to that rule on purpose - two places inventing two short forms for the same franchise is worse than either of them.
export function teamAbbrev(team) {
    if (!team) return '';
    const explicit = (team.abbrev || '').trim();
    if (explicit) return explicit;
    return teamDisplayName(team).substring(0, 4).toUpperCase();
}

export function teamDisplayName(team) {
    if (!team) return '';
    const name = (team.name || '').trim();
    if (name) return name;
    return `${(team.location || '').trim()} ${(team.nickname || '').trim()}`.trim();
}

// H2H or roto, per season, read from the season's own settings rather than assumed from the league. The whole point of the format-drift finding is that one league answers differently per year.
export function seasonFormat(payload) {
    const type = payload?.settings?.scoringSettings?.scoringType || '';
    if (type === 'ROTO') return 'roto';
    if (type === 'H2H_POINTS') return 'points';
    return 'h2h';
}

// The champion, by the rule the season's own format allows. H2H: the winner of the last DECIDED winners-bracket game, which is how data.js already crowns the current season - once a team loses in that bracket it is retiered, so the final round is the only week where the two finalists are both still tagged WINNERS_BRACKET. Roto: rankCalculatedFinal of 1. Measured populated on both finished roto seasons, while rankFinal read 0 on every team of every season and is never used. Returns null on an unfinished season rather than crowning whoever is ahead.
export function championKeyOf(payload) {
    if (!payload || !Array.isArray(payload.teams)) return null;
    const byId = new Map(payload.teams.map(t => [t.id, t]));

    if (seasonFormat(payload) === 'roto') {
        const won = payload.teams.filter(t => t.rankCalculatedFinal === 1);
        // Ranks are not unique keys - a measured season had two franchises tied at 4 - so a tie at the top is reported as no champion rather than as an arbitrary one.
        return won.length === 1 ? franchiseKeyOf(won[0]) : null;
    }

    let finalWeek = null;
    let champion = null;
    (payload.schedule || []).forEach(game => {
        if (game.playoffTierType !== 'WINNERS_BRACKET') return;
        if (finalWeek === null || game.matchupPeriodId > finalWeek) {
            finalWeek = game.matchupPeriodId;
            champion = null;
        }
        if (game.matchupPeriodId !== finalWeek) return;
        if (!game.winner || game.winner === 'UNDECIDED' || game.winner === 'TIE') return;
        const side = game.winner === 'HOME' ? game.home : game.away;
        champion = byId.get(side && side.teamId) || null;
    });
    return champion ? franchiseKeyOf(champion) : null;
}

// One season reduced to what the history view needs. Everything downstream reads these, never the raw payload, so the format branching happens once. Whether a season is OVER. The careers block used to call the newest year live, so a league that finished in April still read "2026 is still being played" in August. The signal is ESPN's own scoring-period pair: latestScoringPeriod is how far the season has got, finalScoringPeriod is where it ends. Measured across four real league payloads - two roto seasons, a categories season and a points season - every one had latest above final, and every one was in fact complete. status.isActive is NOT the signal: it reads true on all four, including seasons two years finished. The negative case is unvalidated: no capture of a season mid-flight exists in the fixture set, so "latest below final means in progress" is read off the field names rather than off data. The fallback under it is the conservative one - a season nobody can measure is treated as settled and says nothing, which is the quiet answer rather than a wrong claim.
export function seasonFinished(payload) {
    const status = (payload && payload.status) || {};
    const latest = Number(status.latestScoringPeriod);
    const final = Number(status.finalScoringPeriod);
    if (Number.isFinite(latest) && Number.isFinite(final)) return latest >= final;
    return true;
}

export function summarizeSeason(payload) {
    if (!payload || !Array.isArray(payload.teams)) return null;
    const format = seasonFormat(payload);
    const counted = format !== 'roto';
    const franchises = payload.teams.map(team => {
        const overall = (team.record && team.record.overall) || {};
        return {
            key: franchiseKeyOf(team),
            teamId: team.id,
            name: teamDisplayName(team),
            abbrev: teamAbbrev(team),
            // Carried raw and UNVETTED. Whether it is loadable is a privacy question, not a data one, and it belongs to whoever renders it - images.js owns the host rule.
            logo: team.logo || null,
            // A roto season has no W-L-T at all. Nulls rather than zeros, so a franchise that has only ever played roto shows blank instead of a fabricated 0-0-0.
            wins: counted ? (overall.wins || 0) : null,
            losses: counted ? (overall.losses || 0) : null,
            ties: counted ? (overall.ties || 0) : null,
            // THE SEASON'S POINTS, WHERE THE FORMAT KEEPS THEM. Two formats do, and the condition is NOT "a points league" - measured on four finished seasons: points league 1204.8 to 1693.2 across eleven teams a real standing ROTO 27, 40.5, 55, 56.5, 61 across five also a real standing h2h categories 0 on every team of both measured seasons carries nothing The roto figures validate themselves: they sum to exactly 240, which is sixteen categories times (1+2+3+4+5). That IS the roto standings total, the thing a roto manager means by points, so excluding roto would drop the one number its season is actually decided by. NULL rather than 0 for h2h categories, because zero there is the absence of a measurement and not a team that scored nothing.
            points: (format === 'points' || format === 'roto')
                ? (Number.isFinite(team.points) ? team.points : null)
                : null,
            finalRank: Number.isFinite(team.rankCalculatedFinal) && team.rankCalculatedFinal > 0
                ? team.rankCalculatedFinal
                : null
        };
    });
    // "Incomplete" is decided from the fields the view actually reads, not from how old the season is. Every full payload measured carried scoring categories, records, final ranks and owners (docs/DATA-SOURCES.md section 9), so no season-count threshold has ever been observed and picking one would be a guess about ESPN's retention. These three signals are not guesses: a season with no categories cannot fill the category table, a season with no teams has nothing to say at all, and a head-to-head season with no schedule cannot produce a champion or a grid. The leagueHistory stub itself trips all three, which is why it is never used as a season.
    const statIds = (payload.settings?.scoringSettings?.scoringItems || [])
        .map(i => String(i.statId)).filter(Boolean);
    const gaps = [];
    if (!statIds.length) gaps.push('categories');
    if (!franchises.length) gaps.push('teams');
    if (counted && !(payload.schedule || []).length) gaps.push('matchups');

    return {
        year: payload.seasonId,
        format,
        countsTowardRecords: counted,
        finished: seasonFinished(payload),
        // Named rather than counted, so the view can say WHAT is missing instead of hedging.
        incomplete: gaps.length ? gaps : null,
        championKey: championKeyOf(payload),
        franchises,
        statIds
    };
}

// Every franchise that ever played, most recent name winning. Seasons are sorted so "most recent" is a fact about the data rather than about the order they happened to be fetched in.
export function buildFranchises(seasons) {
    const byKey = new Map();
    [...seasons].filter(Boolean).sort((a, b) => a.year - b.year).forEach(season => {
        season.franchises.forEach(f => {
            if (!f.key) return;
            const prev = byKey.get(f.key);
            if (prev) {
                prev.name = f.name;
                // The latest season's abbreviation, for the same reason the name takes the latest one: a franchise that rebranded is called what it is called now.
                prev.abbrev = f.abbrev;
                prev.logo = f.logo;
                prev.seasons.push(season.year);
                if (!prev.formerNames.includes(f.name)) prev.formerNames.push(f.name);
            } else {
                byKey.set(f.key, {
                    key: f.key, name: f.name, abbrev: f.abbrev, logo: f.logo,
                    seasons: [season.year], formerNames: [f.name]
                });
            }
        });
    });
    // The current name is not a former name.
    byKey.forEach(f => { f.formerNames = f.formerNames.filter(n => n !== f.name); });
    return [...byKey.values()];
}

// All-time records. Only seasons whose format HAS a record contribute, and the count of those seasons rides along so the view can say what the number covers instead of implying it covers everything.
export function allTimeRecords(seasons) {
    const rows = new Map();
    const list = [...seasons].filter(Boolean).sort((a, b) => a.year - b.year);
    const countedYears = list.filter(s => s.countsTowardRecords).map(s => s.year);
    list.forEach(season => {
        season.franchises.forEach(f => {
            if (!f.key) return;
            if (!rows.has(f.key)) {
                rows.set(f.key, {
                    key: f.key, name: f.name, seasonsPlayed: 0,
                    wins: 0, losses: 0, ties: 0, titles: 0, recordSeasons: 0
                });
            }
            const row = rows.get(f.key);
            row.name = f.name;
            row.seasonsPlayed += 1;
            if (season.countsTowardRecords) {
                row.wins += f.wins || 0;
                row.losses += f.losses || 0;
                row.ties += f.ties || 0;
                row.recordSeasons += 1;
            }
            if (season.championKey && season.championKey === f.key) row.titles += 1;
        });
    });
    const out = [...rows.values()].map(r => {
        const games = r.wins + r.losses + r.ties;
        // A tie is half a win, the convention every fantasy standings page uses. Null rather than 0 when a franchise has never played a season that keeps a record.
        return { ...r, winPct: games ? (r.wins + r.ties / 2) / games : null };
    });
    out.sort((a, b) => (b.titles - a.titles)
        || ((b.winPct === null ? -1 : b.winPct) - (a.winPct === null ? -1 : a.winPct))
        || (b.wins - a.wins));
    return { rows: out, countedYears };
}

// ONE W-L-T FORMATTER, used by every surface that prints a record. The pager and the standings agreed on the numbers and still disagreed on the page: 54-9 against 54-9-0, the same record written two ways, which reads as two values. A zero tie is dropped, since that is how a record with no ties is written, and there is now exactly one place that decides.
export function recordText(wins, losses, ties) {
    const w = Number(wins) || 0;
    const l = Number(losses) || 0;
    const t = Number(ties) || 0;
    return `${w}-${l}${t ? `-${t}` : ''}`;
}

// A POSTSEASON GAME, by ESPN's own tier field. Measured values across the fixture set: NONE, WINNERS_BRACKET, WINNERS_CONSOLATION_LADDER, LOSERS_CONSOLATION_LADDER. Anything that is not NONE was played in the playoff weeks.
export function isPostseasonGame(game) {
    const tier = game && game.playoffTierType;
    return !!tier && tier !== 'NONE';
}

// Every franchise against every other, from H2H seasons only. Keyed "A|B" with A the lower key so one entry serves both directions and the grid reads either way round. REGULAR SEASON ONLY. The pager's "against the league" line is the sum of these rows and has to be the same number the All-Time Standings show for that franchise, and the standings read ESPN's own team.record.overall. DIAGNOSED, not assumed: record.overall counts exactly the games whose playoffTierType is NONE. Checked on all 11 real captures in the fixture set - three scoring formats, 4, 6 and 20 team leagues - and it holds for every team of every one. The owner's reported case is in there: 11-9-1 in the standings against 12-10-1 in the pager, which is that franchise's two postseason games. Leagues whose schedule has no postseason tier at all never disagreed, which is the same finding from the other side. So the postseason is not dropped, it is MOVED: rivalryDetail below still counts those meetings and the card reports them under their own heading, which is the entry's rule - the pane may count more than the standings as long as it says so rather than disagreeing in silence.
export function headToHead(seasons, payloadsByYear) {
    const pairs = new Map();
    const entry = (aKey, bKey) => {
        const [x, y] = aKey < bKey ? [aKey, bKey] : [bKey, aKey];
        const id = `${x}|${y}`;
        if (!pairs.has(id)) pairs.set(id, { a: x, b: y, aWins: 0, bWins: 0, ties: 0, postseason: 0 });
        return pairs.get(id);
    };
    const bump = (aKey, bKey, result) => {
        if (!aKey || !bKey || aKey === bKey) return;
        const rec = entry(aKey, bKey);
        if (result === 'TIE') { rec.ties += 1; return; }
        const winnerIsX = (result === aKey) === (rec.a === aKey);
        if (winnerIsX) rec.aWins += 1; else rec.bWins += 1;
    };
    // Counted but NOT folded into the record. Two franchises whose only meeting was a playoff game have a pair entry with an empty record, which is what keeps the view from calling them never-met - a real thing to get wrong once the record stopped counting the postseason.
    const bumpPostseason = (aKey, bKey) => {
        if (!aKey || !bKey || aKey === bKey) return;
        entry(aKey, bKey).postseason += 1;
    };

    [...seasons].filter(Boolean).forEach(season => {
        if (!season.countsTowardRecords) return;
        const payload = payloadsByYear && payloadsByYear[season.year];
        if (!payload || !Array.isArray(payload.schedule)) return;
        const keyOfTeam = new Map(season.franchises.map(f => [f.teamId, f.key]));
        payload.schedule.forEach(game => {
            const home = game.home && keyOfTeam.get(game.home.teamId);
            const away = game.away && keyOfTeam.get(game.away.teamId);
            // A bye is a schedule entry with one side, which is a real thing in playoffs and must not be counted as a loss for anybody.
            if (!home || !away) return;
            if (!game.winner || game.winner === 'UNDECIDED') return;
            if (isPostseasonGame(game)) { bumpPostseason(home, away); return; }
            if (game.winner === 'TIE') { bump(home, away, 'TIE'); return; }
            bump(home, away, game.winner === 'HOME' ? home : away);
        });
    });
    return [...pairs.values()];
}

// The Tier-2 union: every category ever scored, with the seasons each was scored in. Coverage is carried as the season list rather than a count, so the view can say "scored in 3 of 5 seasons" AND leave the right cells blank without a second pass.
export function categoryUnion(seasons) {
    const list = [...seasons].filter(Boolean).sort((a, b) => a.year - b.year);
    const years = list.map(s => s.year);
    const byStat = new Map();
    list.forEach(season => {
        season.statIds.forEach(id => {
            if (!byStat.has(id)) byStat.set(id, []);
            if (!byStat.get(id).includes(season.year)) byStat.get(id).push(season.year);
        });
    });
    return {
        totalSeasons: years.length,
        years,
        stats: [...byStat.entries()]
            .map(([statId, scoredIn]) => ({ statId, scoredIn, coverage: scoredIn.length }))
            // Most-covered first: a category every season scored is the one worth reading across.
            .sort((a, b) => (b.coverage - a.coverage) || (a.statId.localeCompare(b.statId)))
    };
}

// A rate across seasons is derived from SUMMED COMPONENTS, never from averaged season rates. An average of averages weights a 12-game season the same as a 162-game one, which is how a career batting average comes out wrong. Components are summed first, then divided once.
export function careerRate(componentTotals, spec) {
    if (!spec || !Array.isArray(spec.numerator) || !Array.isArray(spec.denominator)) return null;
    const sum = (ids) => ids.reduce((total, id) => {
        const v = Number(componentTotals[id]);
        return total + (Number.isFinite(v) ? v : 0);
    }, 0);
    const missing = [...spec.numerator, ...spec.denominator]
        .some(id => componentTotals[id] === undefined || componentTotals[id] === null);
    if (missing) return null;
    const den = sum(spec.denominator);
    if (!den) return null;
    const value = sum(spec.numerator) / den;
    return Number.isFinite(value) ? value * (spec.scale || 1) : null;
}

// A player's career IN THIS LEAGUE. Pure, like everything above it. VALIDATED before use, because the entry asserted it rather than measured it: ESPN player ids ARE stable across seasons. 797 ids appear in all three seasons of the measured league, and the ten whose text differs are the same person under a name variant - "Alex Wennberg" and "Alexander Wennberg", "Johnny Beecher" and "John Beecher". So the id is the identity and the NAME drifts, exactly as franchise names do, and the most recent name is the one to show. FORMAT DRIFT DOES NOT APPLY HERE, and that is the point worth stating rather than leaving implicit. A roto season's players count toward a career exactly like a head-to-head season's, because what is summed is raw components - hits, at-bats, goals, shots - and those are recorded the same way whatever the league does with them afterwards. Format decides how a season is WON, not what a player DID. This is the one part of League History that reads every season alike. Scope is players a franchise actually ROSTERED. A pool carries the whole player universe (1627 entries against 134 rostered in one measured season), and a career table of players nobody in the league ever owned is not league history.
function seasonTotalsOf(entry) {
    const stats = (entry && entry.player && entry.player.stats) || [];
    // statSourceId 0 is real (not projected) and statSplitTypeId 0 is the season total. Both are required: the same player carries projections and per-period splits in the same array.
    const block = stats.find(s => s.statSourceId === 0 && s.statSplitTypeId === 0);
    return (block && block.stats) || null;
}

// ownersByYear is { year: Map<playerId, teamId[]> } - every franchise that held the player at any point that season, from the draft and transaction log. Optional: without it this falls back to the pool's onTeamId, which is what the bug was.
export function buildCareers(poolsByYear, seasonsByYear, ownersByYear) {
    const players = new Map();
    const years = Object.keys(poolsByYear || {}).map(Number).sort((a, b) => a - b);

    years.forEach(year => {
        const pool = poolsByYear[year];
        const season = seasonsByYear ? seasonsByYear[year] : null;
        const owners = (ownersByYear && ownersByYear[year]) || null;
        const franchiseOfTeam = new Map((season ? season.franchises : []).map(f => [f.teamId, f]));
        ((pool && pool.players) || []).forEach(entry => {
            // WHO HELD THE PLAYER THAT SEASON, not who holds them now. onTeamId is the roster as of the moment the pool was fetched, so a player dropped before that read as never having been in the league - and the bug was bigger than the missing franchise: this early return dropped the STATS and the season itself too, so a drafted-and-dropped player lost a whole year of a career. Measured on a real capture: 138 of 1039 pool entries were rostered at fetch time, so the snapshot is the exception, not the rule. The transaction log answers it properly, and the owner's ruling is that any stint counts however short. onTeamId stays as the fallback for a season whose log could not be read, which is the golden rule 8 behaviour rather than a blank column.
            const entryId = entry.id || (entry.player || {}).id;
            const held = (owners && owners.get(entryId)) || [];
            const teamIds = held.length ? held : (entry.onTeamId ? [entry.onTeamId] : []);
            if (!teamIds.length) return;
            const info = entry.player || {};
            const id = entry.id || info.id;
            if (id === null || id === undefined) return;
            const totals = seasonTotalsOf(entry);
            if (!totals) return;

            if (!players.has(id)) {
                players.set(id, { id, name: '', eligibleSlots: [], defaultPositionId: null, seasons: [], franchiseKeys: [], totals: {} });
            }
            const row = players.get(id);
            // Years ascend, so the last write is the most recent name. Eligibility rides along for the same reason and gets the same treatment: a player who moved from the outfield to first base is grouped by the position played NOW, not by where that career started.
            if (info.fullName) row.name = info.fullName;
            // The pool carries eligibleSlots, not eligiblePositions - measured on all three captures, every rostered player had the slots and none had the positions. Decoding is the caller's job, since the slot map is per sport and this file stays pure.
            if (Array.isArray(info.eligibleSlots)) row.eligibleSlots = info.eligibleSlots;
            if (Number.isFinite(info.defaultPositionId)) row.defaultPositionId = info.defaultPositionId;
            if (!row.seasons.includes(year)) row.seasons.push(year);
            teamIds.forEach(teamId => {
                const franchise = franchiseOfTeam.get(teamId);
                if (franchise && franchise.key && !row.franchiseKeys.includes(franchise.key)) {
                    row.franchiseKeys.push(franchise.key);
                }
            });
            Object.keys(totals).forEach(statId => {
                const v = Number(totals[statId]);
                if (!Number.isFinite(v)) return;
                row.totals[statId] = (row.totals[statId] || 0) + v;
            });
        });
    });

    return [...players.values()].sort((a, b) => (b.seasons.length - a.seasons.length)
        || a.name.localeCompare(b.name));
}

// Career values for one union column. A rate is rebuilt from the summed components rather than summed itself, which is the whole reason careerRate exists - a summed batting average is meaningless and an averaged one is wrong.
export function careerValue(row, statId, rateSpecs) {
    const spec = (rateSpecs || []).find(s => String(s.out) === String(statId));
    if (!spec) {
        const v = row.totals[statId];
        return v === undefined ? null : v;
    }
    // An "add" rate is built from other rates (OPS is OBP plus SLG), so each part is derived first.
    if (spec.add) {
        const parts = spec.add.map(id => careerValue(row, id, rateSpecs));
        return parts.some(p => p === null) ? null : parts.reduce((a, b) => a + b, 0);
    }
    return careerRate(row.totals, { numerator: spec.num, denominator: spec.den, scale: spec.scale });
}

// Sorting the career table. Pure, and separate from careerValue, because the two rules that make this easy to get wrong by hand are both about what is NOT a number. A BLANK IS NOT A SMALL NUMBER. A skater has no GAA at all, and sorting that row to the bottom of a descending column and the top of an ascending one would make the skater the best goalie on the second click. Blanks sort last whichever way the column points, and hold their own alphabetical order among themselves. Ties break by name rather than by whatever order the rows arrived in, so a column with many equal values is stable to read and does not reshuffle when the same sort is applied twice.
export function sortCareers(rows, spec) {
    const list = [...(rows || [])];
    if (!spec || !spec.key) return list;
    const sign = spec.dir === 'asc' ? 1 : -1;
    const valueOf = (row) => {
        if (spec.key === 'name') return row.name;
        if (spec.key === 'seasons') return row.seasons.length;
        return careerValue(row, spec.key, spec.rateSpecs);
    };
    return list.sort((a, b) => {
        const va = valueOf(a);
        const vb = valueOf(b);
        const blankA = va === null || va === undefined || va === '';
        const blankB = vb === null || vb === undefined || vb === '';
        if (blankA && blankB) return a.name.localeCompare(b.name);
        if (blankA) return 1;
        if (blankB) return -1;
        if (typeof va === 'string' || typeof vb === 'string') {
            return sign * String(va).localeCompare(String(vb));
        }
        if (va === vb) return a.name.localeCompare(b.name);
        return sign * (va < vb ? -1 : 1);
    });
}

// ==== Pane arithmetic. Every sizing rule on this tab is computed from COUNTS against a constant and never from a measured element - the rule. These live here so they are unit-tested rather than reasoned about in a stylesheet. ====

// THE CATEGORIES ROW PITCH. What the bug was: the table carried height: 100%, and CSS table layout hands a table's surplus height to its ROW boxes - td { height: 16px } is a minimum there, never a cap, so nothing bounded the growth. Two seasons in a 326px table became two 154px rows, and since a cell's default vertical-align is middle, each row's text floated in the centre of its own band. That is the "header in a void with the rows glued low" the owner photographed: no margin and no space-between anywhere, just a table told to be tall. The replacement is this: the rows get a comfortable pitch computed from how many there are, the header sits directly on top of them, and whatever is left over stays left over. A budget divided by a count, clamped at both ends - no element is measured and nothing floats.
export const CATEGORY_ROW_MIN = 20;
export const CATEGORY_ROW_MAX = 34;
// The scroll frame at 1280x800 less its heading row, measured once and held as a constant the way every other budget on this tab is. Being wrong by a few pixels costs nothing here: too small only means the rows stop growing sooner, and too large is caught by the clamp.
export const CATEGORY_ROWS_BUDGET = 320;

export function categoryRowHeight(seasonCount, budget = CATEGORY_ROWS_BUDGET) {
    const n = Math.max(1, Math.floor(seasonCount) || 1);
    const share = Math.floor(budget / n);
    return Math.min(CATEGORY_ROW_MAX, Math.max(CATEGORY_ROW_MIN, share));
}

// THE RIVALRY. Everything the detail card says about one pair of franchises, from the payloads League History already holds - no fetch of any kind. headToHead above collapses a pair to one record because the list only needs the total; this keeps the MEETINGS, because a streak, a run and a last meeting are all questions about their order. Only seasons that count toward records contribute, for the reason the rest of this file gives: a roto season has no matchups, so it cannot host a meeting. A postseason meeting is any game whose playoffTierType is not NONE. Measured values across the fixture set: NONE, WINNERS_BRACKET, WINNERS_CONSOLATION_LADDER and LOSERS_CONSOLATION_LADDER. The consolation ladders are counted in, since they are played in the playoff weeks and are postseason games - the alternative reads "no playoff meetings" about two franchises who met in week 23.
export function rivalryDetail(seasons, payloadsByYear, aKey, bKey) {
    const empty = {
        meetings: [], total: { w: 0, l: 0, t: 0 }, seasons: [], streak: null, longest: null,
        playoff: { total: 0, aWins: 0, bWins: 0, ties: 0 }, last: null
    };
    if (!aKey || !bKey || aKey === bKey) return empty;

    const meetings = [];
    [...(seasons || [])].filter(Boolean).sort((x, y) => x.year - y.year).forEach(season => {
        if (!season.countsTowardRecords) return;
        const payload = payloadsByYear && payloadsByYear[season.year];
        if (!payload || !Array.isArray(payload.schedule)) return;
        const keyOfTeam = new Map(season.franchises.map(f => [f.teamId, f.key]));
        // Sorted by matchup period, because "the last meeting" and "three straight" are claims about order and a schedule array's own order is not promised to be chronological.
        const games = payload.schedule
            .filter(game => {
                const home = game.home && keyOfTeam.get(game.home.teamId);
                const away = game.away && keyOfTeam.get(game.away.teamId);
                if (!home || !away) return false;
                return (home === aKey && away === bKey) || (home === bKey && away === aKey);
            })
            .sort((g, h) => (g.matchupPeriodId || 0) - (h.matchupPeriodId || 0));
        games.forEach(game => {
            if (!game.winner || game.winner === 'UNDECIDED') return;
            const homeKey = keyOfTeam.get(game.home.teamId);
            let result = 'tie';
            if (game.winner !== 'TIE') {
                const winnerKey = game.winner === 'HOME' ? homeKey : keyOfTeam.get(game.away.teamId);
                result = winnerKey === aKey ? 'a' : 'b';
            }
            meetings.push({
                year: season.year,
                period: game.matchupPeriodId || 0,
                playoff: isPostseasonGame(game),
                result
            });
        });
    });
    if (!meetings.length) return empty;

    // THE RECORD IS THE REGULAR SEASON, on the same basis headToHead uses and for the same reason: the card's record has to agree with the row that opened it, and that row has to agree with the standings. Postseason meetings are counted separately and reported under their own heading, so nothing is hidden - it is just not silently folded into a number that means something narrower everywhere else.
    const total = { w: 0, l: 0, t: 0 };
    const byYear = new Map();
    const playoff = { total: 0, aWins: 0, bWins: 0, ties: 0 };
    meetings.forEach(m => {
        if (m.playoff) {
            playoff.total += 1;
            if (m.result === 'a') playoff.aWins += 1; else if (m.result === 'b') playoff.bWins += 1; else playoff.ties += 1;
            return;
        }
        if (m.result === 'a') total.w += 1; else if (m.result === 'b') total.l += 1; else total.t += 1;
        if (!byYear.has(m.year)) byYear.set(m.year, { year: m.year, w: 0, l: 0, t: 0 });
        const s = byYear.get(m.year);
        if (m.result === 'a') s.w += 1; else if (m.result === 'b') s.l += 1; else s.t += 1;
    });

    // A TIE ENDS A STREAK rather than extending or reversing it, which is the reading every standings page uses: a run is consecutive wins, and a game nobody won is not one of them. THE CARD'S FACTS SPLIT BY KIND, not by one shared basis. RATIO facts - the record and the season bars - stay regular-season, because they have to reconcile with the rivalry row that opened the card and with the All-Time Standings behind it. Playoff meetings stay their own fact. SEQUENCE facts - the streak and the longest run - read EVERY meeting, alongside the last meeting which already did. A playoff win extends a run, a playoff loss breaks one, and a tie of either kind still ends it. This is the sports-page reading of "has won five straight meetings", which has never excluded the playoffs. The contradiction the old comment here worried about - "3 straight" printed beside a record showing two wins - is accepted and is now TRUE rather than avoided. The playoff-meetings fact on the same card is what explains the difference. The measured alternative was worse: the owner's card claimed a 3-game run for a franchise that had LOST inside it, in the playoffs.
    let streak = null;
    for (let i = meetings.length - 1; i >= 0; i--) {
        const r = meetings[i].result;
        if (r === 'tie') break;
        if (!streak) streak = { side: r, count: 1 };
        else if (streak.side === r) streak.count += 1;
        else break;
    }

    // The run carries EVERY meeting in it, not just its ends. "Season 2026 Matchup 10 to 20" read as eleven matchups when the run was two, so the card names the actual meetings and the range form is gone. Each coordinate carries whether it was a playoff game, so the enumeration can mark it.
    let longest = null;
    let run = null;
    meetings.forEach(m => {
        if (m.result === 'tie') { run = null; return; }
        const at = { year: m.year, period: m.period, playoff: m.playoff };
        run = (run && run.side === m.result)
            ? { side: run.side, count: run.count + 1, meetings: [...run.meetings, at] }
            : { side: m.result, count: 1, meetings: [at] };
        // Strictly greater, so the EARLIEST run of a shared best length is the one reported rather than whichever happened to come last.
        if (!longest || run.count > longest.count) longest = { side: run.side, count: run.count, meetings: [...run.meetings] };
    });

    return {
        meetings,
        total,
        seasons: [...byYear.values()].sort((x, y) => x.year - y.year),
        streak,
        longest,
        playoff,
        // THE LAST MEETING IS THE LAST MEETING. This one fact is about RECENCY, so it reads every meeting - a rivalry whose most recent game was a playoff win said nothing about it and named a regular-season game from five matchups earlier instead. The record, the streak and the longest run stay on the regular-season basis item 1 ruled; only this changes, and the card marks it when the meeting was a playoff game.
        last: meetings[meetings.length - 1] || null
    };
}

// THE SPLIT. Roughly even while the list is short, list-heavy once it is long, because a 19-row list of bars needs the width more than a card of five short lines does. Computed from the opponent count against constants - never from what the rendered list turned out to need.
export const RIVALRY_SPLIT_EVEN_MAX = 8;
export const RIVALRY_SPLIT_HEAVY_MIN = 16;

export function rivalrySplit(opponentCount) {
    const n = Math.max(1, Math.floor(opponentCount) || 1);
    if (n <= RIVALRY_SPLIT_EVEN_MAX) return 0.5;
    if (n >= RIVALRY_SPLIT_HEAVY_MIN) return 0.6;
    const span = RIVALRY_SPLIT_HEAVY_MIN - RIVALRY_SPLIT_EVEN_MAX;
    return 0.5 + ((n - RIVALRY_SPLIT_EVEN_MAX) / span) * 0.1;
}

// ALL FIVE FACTS, IN EVERY LEAGUE. rivalryCardDepth used to decide how many of them the height afforded, and the result was a card that said different things about different leagues - streak and last meeting in the 20-team league, all five in the 4-team one. Facts behind a scrollbar beat facts that do not exist. The deepening order it computed survives only as the DISPLAY order below. There is no height lever left to pull honestly at high counts: the pane is what the standings leave, and the two columns are the same height by construction, so the list cannot cede any to the card. At 20 franchises the card therefore scrolls in its own frame, which is the ruled last resort rather than a compromise on which facts exist.
export const RIVALRY_CARD_SECTIONS = ['longest', 'playoff', 'titles'];

// The run's meetings, named. A range was actively misleading: "Season 2026 Matchup 10 to 20" describes eleven matchups when the run is two wins, so the card enumerates instead. The season is restated only where the year changes, since repeating it on every number is the coordinate dump the owner did not want. one Season 2026 Matchup 10 two Season 2026 Matchup 10 and 20 three or more Season 2026 Matchup 10, 15, and 20 across seasons Season 2023 Matchup 20, Season 2024 Matchup 2, and 5 with a playoff Season 2024 Matchup 20 Playoffs, Season 2025 Matchup 1, and 2 The playoff marker rides WITHOUT a comma here, which is the one departure from the last-meeting fact's "2026 Matchup 24, Playoffs". Inside a comma-separated list that form is ambiguous - "Matchup 2, Playoffs, and 5" reads as three items, one of them called Playoffs. Noted in the entry.
export function runSpanText(run) {
    const meetings = (run && run.meetings) || [];
    if (!meetings.length) return '';
    let lastYear = null;
    const parts = meetings.map(m => {
        const where = m.year === lastYear ? `${m.period}` : `Season ${m.year} Matchup ${m.period}`;
        lastYear = m.year;
        return m.playoff ? `${where} Playoffs` : where;
    });
    if (parts.length === 1) return parts[0];
    // The Oxford comma, which VOICE.md requires and the owner confirmed for this string when the first cut omitted it. A list of TWO takes no comma - that is the same rule, not an exception.
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

// The owner's own franchise, by SWID, the way Team Metrics and My Team already open on it. A franchise key IS the normalized SWID (franchiseKeyOf above), so this is a comparison rather than a second matching rule. Returns 0 when nothing matches, which is the first franchise - a league the user is not in still opens on somebody.
export function defaultFranchiseIndex(franchises, swid) {
    const me = normSwid(swid);
    if (!me) return 0;
    const i = (franchises || []).findIndex(f => f && normSwid(f.key) === me);
    return i >= 0 ? i : 0;
}

// A year list in the app's prose: Oxford comma, "and" before the last (VOICE.md).
function yearPhrase(years) {
    const list = [...(years || [])].sort((a, b) => a - b);
    if (list.length === 0) return '';
    if (list.length === 1) return `${list[0]}`;
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

// The coverage sentence under the pager. Empty when every season counts, since a line saying "all of them" is one nobody needs.
export function coverageSentence(countedYears, allYears) {
    const counted = [...new Set(countedYears || [])].sort((a, b) => a - b);
    const all = [...new Set(allYears || [])].sort((a, b) => a - b);
    const others = all.filter(y => !counted.includes(y));
    if (!counted.length || !others.length) return '';
    const plural = others.length > 1;
    return `Covers ${yearPhrase(counted)}. ${yearPhrase(others)} ${plural ? 'are' : 'is'} not applicable given ${plural ? 'they are' : 'it is'} not head to head.`;
}


// A pennant's two lines. The reference photo is a real ballclub's pennant, where the city runs small and italic above the nickname in block letters - PITTSBURGH over Pirates. A fantasy team has no city, so the split has to come from the name itself, and the rule that reads closest to the reference is that the LAST word is the nickname and whatever precedes it is the line above: "Bunt Force Trauma" hangs as BUNT FORCE over Trauma, which is the shape the reference has. A one-word name gets the nickname line only, and no empty line above it. The nickname is never the empty half for a name with any word in it, because the nickname is the part the pennant is really about - if only one line can be shown it has to be that one.
export function pennantLines(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { top: '', nick: '' };
    return { top: words.slice(0, -1).join(' '), nick: words[words.length - 1] };
}
