import { AppState } from './state.js';
import { setDebugContext, escapeHtml, countApiRequest } from './utils.js';
import { buildRosterTimeline, ownerTeamIdsByPlayer } from './roster-timeline.js';
import { processCoreData } from './data.js';

// The host permission the cookie reads and every ESPN fetch depend on.
const ESPN_ORIGINS = { origins: ['*://*.espn.com/*'] };

// Firefox MV3 treats host_permissions as OPT-IN: about:debugging grants them for a temporary add-on, but a store or file install does not, so cookies.get quietly returns nothing (or throws) until the user grants access - every AMO install from 1.0.0 to 1.1.1 hit this. Chrome grants host permissions at install time, so contains() is already true there and the prompt below never renders. A browser with no permissions API at all is treated as granted, which is what keeps the dev-preview stub path unchanged.
async function hasEspnHostAccess() {
    try {
        if (!browser.permissions?.contains) return true;
        return await browser.permissions.contains(ESPN_ORIGINS);
    } catch {
        return true;
    }
}

// Cookie reads throw rather than return null when the host permission is missing, and the caller only needs "is it there", so a failure is the same answer as an absent cookie.
async function readEspnCookie(name) {
    try {
        return await browser.cookies.get({ url: 'https://espn.com', name });
    } catch {
        return null;
    }
}

// True once checkAuth has seen both cookies. The watchers below read it so a green dashboard is never re-checked, which is what keeps the status from flickering and the league picker from being rebuilt under a user who is already using it.
let authSatisfied = false;

export async function checkAuth() {
    const s2Cookie = await readEspnCookie('espn_s2');
    const swidCookie = await readEspnCookie('SWID');
    const authStatus = document.getElementById('auth-status');
    const grantBtn = document.getElementById('grant-access-btn');
    if (grantBtn) grantBtn.style.display = 'none';

    if (s2Cookie && swidCookie) {
        // Success needs no banner - only a missing-cookies problem is worth surfacing.
        authStatus.textContent = '';
        authStatus.style.display = 'none';
        // Remember the SWID so the weekly recap can auto-pick "my team" (matches team owners).
        AppState.userSwid = swidCookie.value || '';
        // Fire-and-forget league discovery - the manual sport/league-id/year fields work exactly as before whether or not this succeeds. Only the FIRST green run builds the picker, so a watcher that fires again never rebuilds a list the user is reading.
        if (!authSatisfied) populateLeaguePicker(swidCookie.value).catch(() => {});
        const wasSatisfied = authSatisfied;
        authSatisfied = true;
        // The moment a logged-out session becomes a logged-in one, which B91's watchers already detect within a focus or a cookie change. Anything that failed for want of a login can now succeed, so say so and let main.js decide what to reload - api.js importing players.js would close a cycle (see the post-fetch hook below for the same reasoning). Fires on a normal logged-in load too, where the handler finds nothing broken and stops.
        if (!wasSatisfied) document.dispatchEvent(new CustomEvent('leaguewise:auth-restored'));
        return;
    }

    authSatisfied = false;
    authStatus.style.display = '';
    authStatus.className = 'status-red';

    // No cookies could mean no ESPN login, or that this install was never granted espn.com at all. Ask the permission first. Only when it IS granted is "log in" the honest diagnosis.
    if (!(await hasEspnHostAccess())) {
        authStatus.textContent = '⚠️ Leaguewise needs access to espn.com.';
        if (grantBtn) {
            grantBtn.style.display = '';
            // The request MUST be the first thing the click does. Awaiting anything before it loses the user gesture Firefox requires, and the prompt is then refused silently. onclick rather than addEventListener so a re-render never stacks handlers.
            grantBtn.onclick = () => {
                browser.permissions.request(ESPN_ORIGINS)
                    .then(granted => { if (granted) checkAuth(); })
                    .catch(() => {});
            };
        }
        return;
    }

    authStatus.textContent = '❌ Missing Cookies. Log into ESPN Fantasy first.';
}

// Install first, log in second is the NORMAL first run, and until the dashboard never noticed: the warning sat there until a manual refresh, and because checkAuth had already run pre-login the My Leagues picker stayed empty too, so the first outside user had to hunt down a league id by hand. Two layers, because neither is sufficient alone. One re-check at a time, and never while the state is already green. checkAuth is idempotent, but a focus flurry would still run it several times and rebuild the picker under someone reading it.
let authRecheckTimer = null;
function recheckAuthSoon() {
    if (authSatisfied || authRecheckTimer) return;
    authRecheckTimer = setTimeout(() => {
        authRecheckTimer = null;
        checkAuth();
    }, 250);
}

export function setupAuthWatchers() {
    // Layer 1, the precise one. The cookies permission already covers this listener, and it only ever fires once the host permission is granted, which is exactly when cookie visibility begins. So it covers grant-then-login and login-then-grant alike. Guarded the way 1.1.2 guards permissions, since the dev-preview stub has no cookies.onChanged.
    try {
        browser.cookies?.onChanged?.addListener((change) => {
            const domain = change?.cookie?.domain || '';
            if (domain.includes('espn.com')) recheckAuthSoon();
        });
    } catch { /* no listener available, the focus layer below still covers it */ }

    // Layer 2, the one that needs no permissions at all. Coming back to this page is the moment a user returns from logging in. Both events fire in the cases that matter (a tab regaining focus, a popup being reopened), and recheckAuthSoon collapses them into one check.
    window.addEventListener('focus', recheckAuthSoon);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') recheckAuthSoon();
    });
}

// ESPN's fan-profile endpoint knows every fantasy league the logged-in account belongs to - keyed by the SWID cookie, authenticated by the same espn_s2 cookie every other call here already uses (fan.api.espn.com is under the.espn.com cookie domain and the extension's existing *.espn.com host permission). gameId mapping per entry: 1=ffl, 2=flb, 3=fba, 4=fhl. UNVERIFIED against a real account as written - the exact response shape (entry.name vs groups[].groupName for the league's display name, especially) needs one validation pass with real cookies, which is why parsing is defensive field-by-field and any failure just leaves the picker hidden. Also unverified: that a multi-season league actually surfaces one pref.metaData.entry per season (the assumption the sport:leagueId dedupe below relies on to pick the highest seasonId) rather than some other shape. Best-effort by design. Manual league-id entry remains the fallback for public leagues the user isn't a member of, and for any account this endpoint misbehaves for.
const FAN_API_GAME_IDS = { 1: 'ffl', 2: 'flb', 3: 'fba', 4: 'fhl' };
const SUPPORTED_SPORTS = new Set(['flb', 'fhl']);

// The full cross-sport league list from the last successful discovery, kept in memory so a #sport change can re-render the picker filtered to the selected sport without re-fetching the fan API.
let discoveredLeagues = [];

export async function populateLeaguePicker(swid) {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;

    const data = await fetchEspnJson(`https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`);

    // Keyed by sport:leagueId (NOT:seasonId) - the fan API can list the same league once per season it knows about, which used to multiply entries in the dropdown. Keep only the highest seasonId per league; that's also the season the onchange handler below will auto-select in the Year dropdown, so the kept entry matches what clicking it actually does.
    const byLeague = new Map();
    (data.preferences || []).forEach(pref => {
        const entry = pref.metaData?.entry;
        const group = entry?.groups?.[0];
        const sport = FAN_API_GAME_IDS[entry?.gameId];
        if (!entry || !group?.groupId || !SUPPORTED_SPORTS.has(sport)) return;
        const leagueId = group.groupId.toString();
        const key = `${sport}:${leagueId}`;
        const existing = byLeague.get(key);
        if (existing && (existing.seasonId || 0) >= (entry.seasonId || 0)) return;
        // No seasonId in the label - the Year dropdown already owns year selection, and baking one in here read like the league itself was restricted to that single season. No sport suffix either. The picker is now filtered to the selected sport, so "(MLB)"/"(NHL)" only restated what the Sport control already says.
        byLeague.set(key, {
            key,
            leagueId,
            sport,
            seasonId: entry.seasonId,
            label: group.groupName || entry.name || `League ${leagueId}`
        });
    });
    discoveredLeagues = Array.from(byLeague.values());
    if (discoveredLeagues.length === 0) return;

    select.onchange = () => {
        // Guard the "Choose..." placeholder explicitly - its value is '' and no league matches it.
        if (select.value === '') return;
        // Values are stable sport:leagueId keys, not list indices, so this lookup survives the sport-filtered re-renders that rebuild the option set.
        const league = discoveredLeagues.find(l => l.key === select.value);
        if (!league) return;
        document.getElementById('sport').value = league.sport;
        document.getElementById('league-id').value = league.leagueId;
        const yearSelect = document.getElementById('year');
        const seasonStr = league.seasonId?.toString();
        if (seasonStr && Array.from(yearSelect.options).some(o => o.value === seasonStr)) {
            yearSelect.value = seasonStr;
        }
        fetchEspnData();
    };

    renderMyLeaguesOptions();
}

// Render the My Leagues picker filtered to the currently selected sport, from the in-memory discovered list. Called on first discovery and on every #sport change (wired in main.js), so hockey leagues never show while Baseball is selected and vice versa. A sport switch that filters out the current selection falls back to the "Choose..." placeholder here WITHOUT fetching - rebuilding the option set fires no change event, and a value from the other sport is absent from these options, so it resets cleanly with no stale selection. A single-sport account viewing its own sport still sees its full list, unchanged.
export function renderMyLeaguesOptions() {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;
    const currentSport = document.getElementById('sport').value;
    const forSport = discoveredLeagues.filter(l => l.sport === currentSport);
    if (forSport.length === 0) {
        // Nothing discovered for this sport - hide the picker (manual league-id entry still works).
        select.value = '';
        wrap.style.display = 'none';
        return;
    }
    select.innerHTML = '<option value="">Choose...</option>' +
        forSport.map(l => `<option value="${escapeHtml(l.key)}">${escapeHtml(l.label)}</option>`).join('');
    wrap.style.display = '';
}

export async function loadStoredSettings() {
    const stored = await browser.storage.local.get(['sport', 'leagueId', 'year']);
    if (stored.sport) document.getElementById('sport').value = stored.sport;
    if (stored.leagueId) document.getElementById('league-id').value = stored.leagueId;
    if (stored.year) document.getElementById('year').value = stored.year;

    const session = await browser.storage.session.get(['apiData', 'leagueHistoryYears']);
    if (session.apiData) {
        AppState.apiData = session.apiData;
        AppState.leagueHistoryYears = session.leagueHistoryYears || [];
        // This restore path (reopening the extension on an already-loaded session) never went through fetchEspnData, so the debug panel's 'team' context was staying permanently empty until the next manual "Fetch Data" click - only ever populated on a fresh fetch.
        setDebugContext('team', session.apiData);
        processCoreData();
    }
}

// Reads the sport/league/year the user has entered - the same three fields every ESPN fantasy API call in this file needs to build its URL.
function getLeagueParams() {
    return {
        sport: document.getElementById('sport').value,
        leagueId: document.getElementById('league-id').value,
        year: document.getElementById('year').value
    };
}

// Runs `worker` over every item in `items`, at most `limit` calls in flight at once - fails fast on the first rejection, same as Promise.all would.
async function runWithConcurrencyLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runNext() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await worker(items[i], i);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
    return results;
}

// Shared fetch/throw/parse for an ESPN fantasy API call - every endpoint here sends cookies via credentials:'include' and, when filtering the response server-side, an X-Fantasy-Filter header. A non-ok response always means something ESPN-specific went wrong (bad league id, private league, expired auth), worth surfacing as a real Error rather than continuing with a broken response body. VALIDATED against a real logged-out session. ESPN refuses an unauthenticated player-pool request with 405, not 401. That call is the only one carrying an X-Fantasy-Filter header, and the filter is what it objects to. A league read with restrictionType NONE meanwhile succeeds outright with no cookies at all. So the three statuses below mean one thing between them, "you are not logged in", and callers phrase it rather than printing a number at someone who cannot act on it.
const AUTH_STATUSES = new Set([401, 403, 405]);

// Which call this was, read off the URL rather than threaded through every caller. Every request in this file is identifiable from its own view or path, so the tally stays a one-line change at the single call site instead of a parameter on a dozen functions ( item 8). Ordered most specific first: a weekly-stats request IS a kona_player_info request with a scoring-period filter, so plain "pool" has to be the fallback of the two, not the match.
function requestKindOf(url, filter) {
    const u = String(url);
    if (u.includes('fan.api.espn.com')) return 'league list';
    if (u.includes('/leagueHistory/')) return 'history';
    if (u.includes('proTeamSchedules_wl')) return 'schedule';
    if (u.includes('/scoreboard')) return 'scoreboard';
    if (u.includes('view=mRoster')) return 'rosters';
    if (u.includes('kona_player_info')) {
        const f = filter ? JSON.stringify(filter) : '';
        return f.includes('filterStatsForTopScoringPeriodIds') ? 'weekly' : 'pool';
    }
    if (u.includes('/segments/0/leagues/')) return 'league';
    return 'other';
}

async function fetchEspnJson(url, filter) {
    const headers = filter ? { 'X-Fantasy-Filter': JSON.stringify(filter) } : {};
    // Counted BEFORE the await, so a request that fails still counts - it was still made, and the question the panel answers is what this page asked for, not what came back.
    countApiRequest(url, requestKindOf(url, filter));
    const response = await fetch(url, { credentials: 'include', headers });
    if (!response.ok) {
        // The message keeps the status for the diagnostic panel and any log; authRequired is what the UI branches on, so no surface has to know which code ESPN chose this time.
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        err.authRequired = AUTH_STATUSES.has(response.status);
        throw err;
    }
    return response.json();
}

export async function fetchPlayerData() {
    const { sport, leagueId, year } = getLeagueParams();
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=kona_player_info`;
    const filter = {
        players: {
            limit: 3000,
            sortPercOwned: { sortPriority: 1, sortAsc: false },
            filterStatsForSourceIds: { value: [0, 1] },
            filterStatsForSplitTypeIds: { value: [0] }
        }
    };
    return fetchEspnJson(url, filter);
}

export async function fetchPlayerWeeklyStats(playerId) {
    // Delegates to the bulk endpoint below with a single id - same request shape (and same { players: [...] } response shape, since processPlayerWeeklyHistory already flattens across however many entries rawData.players holds), one less code path to keep in sync.
    return fetchPlayersWeeklyStatsBulk([playerId]);
}

// Fetches weekly/daily stat history for MANY players in one shot, instead of one HTTP request per player - needed to make the Player Metrics leaderboard timeframe-aware (see getEffectivePlayerPool in players.js) without one request per player in the pool. Chunked because a single request with hundreds of IDs risks an unreasonably large response/URL, and capped to a handful in flight at once (MAX_CONCURRENT_CHUNKS) - an especially deep player pool can chunk into 10+ requests, and firing all of them at ESPN simultaneously risks tripping their own rate limiting for what should look like normal browsing traffic. Relies on filterIds.value accepting multiple IDs at once (same array-based filter shape ESPN already uses elsewhere in this file, e.g. filterStatsForTopScoringPeriodIds.additionalValue below) - CONFIRMED working against a real league. MLB/NHL use daily scoring periods (~185-195 per season) - filterStatsForTopScoringPeriodIds is bumped well past a single season's day count so "top N" never truncates anything. A chart that still "starts late" or "ends early" after this isn't a fetch problem - cross-checked two different real players in the same league/season both missing the exact same early days, and one was confirmed genuinely injured that whole stretch. See the gap-note UI in drawPlayerTrendChart (players.js) for surfacing that distinction instead of chasing it as a fetch bug.
export const WEEKLY_CHUNK_SIZE = 75;
export const WEEKLY_MAX_CONCURRENT_CHUNKS = 6;

// ONE weekly-stats request for one chunk of ids. This is the unit the leaderboard's prioritized queue schedules (see players.js). It owns the ordering and the concurrency so a scroll or re-sort can change what the NEXT chunk asks for, which a self-chunking call can't express. A drill-down's single-player fetch goes through fetchPlayersWeeklyStatsBulk below instead, so it is never counted against that queue's concurrency budget and never waits behind a bulk chunk. The request shape is deliberately unchanged from the self-chunking version this replaced. filterStatsForSourceIds still asks for [0, 1] even though the weekly processing only reads statSourceId 0 (real, not projected) - dropping the 1 looks like free payload savings, but golden rule 4's "never guess a request shape" applies here too, and it can only be settled by diffing a real trimmed response against the current one for a known player. Left as-is until that check runs against a live league.
export async function fetchPlayersWeeklyChunk(playerIds) {
    const { sport, leagueId, year } = getLeagueParams();
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=kona_player_info`;
    return fetchEspnJson(url, {
        players: {
            filterIds: { value: playerIds },
            filterStatsForSourceIds: { value: [0, 1] },
            filterStatsForTopScoringPeriodIds: { value: 2000, additionalValue: [`00${year}`, `01${year}`] }
        }
    });
}

export async function fetchPlayersWeeklyStatsBulk(playerIds) {
    const chunks = [];
    for (let i = 0; i < playerIds.length; i += WEEKLY_CHUNK_SIZE) {
        chunks.push(playerIds.slice(i, i + WEEKLY_CHUNK_SIZE));
    }

    const responses = await runWithConcurrencyLimit(chunks, WEEKLY_MAX_CONCURRENT_CHUNKS, fetchPlayersWeeklyChunk);

    // Merge every chunk's players array into one combined response shape - the caller doesn't need to know this was chunked at all.
    return { players: responses.flatMap(r => r.players || []) };
}

// The draft picks = day-one rosters. Fetched with its own view since the main league fetch doesn't request mDraftDetail. Returns the picks array (playerId/teamId per pick), or [] if the league has no draft detail (some formats) - best-effort, the roster timeline falls back to current rosters if this is empty (golden rule 8).
export async function fetchDraftDetail(sport, leagueId, year) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mDraftDetail`;
        const data = await fetchEspnJson(url);
        return (data && data.draftDetail && data.draftDetail.picks) || [];
    } catch {
        return [];
    }
}

// One scoring period's transaction slice. mTransactions2 silently scopes to the CURRENT period unless an explicit scoringPeriodId is passed (M0 probe C), which is why the plain call read empty for a completed season. Batching many periods through X-Fantasy-Filter returned 0 rows (M0), so the harvest is genuinely one request per period.
async function fetchTransactionPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTransactions2&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        return (data && data.transactions) || [];
    } catch {
        return [];
    }
}

// Harvest the whole season's transaction log, one request per scoring period from first to final, merged into a single array. Concurrency-capped like the weekly fetch so a ~196-request hockey season looks like normal browsing traffic, not a burst. This is the expensive, one-time cost of transaction-accurate rosters; callers cache the result for the session (see players.js), and it's the natural artifact a future archive would keep so it never re-fetches. De-duplicated by transaction id because ESPN can echo a multi-period transaction into more than one period slice.
export async function harvestTransactions(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);

    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchTransactionPeriod(sport, leagueId, year, period));

    const byId = new Map();
    slices.flat().forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
    return Array.from(byId.values());
}

// The pro sports schedule, which is what turns a probable-start game id into a day. A SEASON endpoint, not a league one. It carries no league id, needs no cookies, and is the same host the manifest already lists, so it adds no permission and no privacy question. One fetch per sport and season, cached in session storage. The response is ~850KB for baseball and a season's schedule does not move, so re-fetching it on every My Team render would be pure waste. Failure is silent by design. The tab's projected-start line does not render, and nothing else on the page depends on it.
export async function fetchProTeamSchedules() {
    const { sport, year } = getLeagueParams();
    const key = `proTeamSchedules:${sport}:${year}`;
    if (AppState.proTeamSchedules && AppState.proTeamSchedules.key === key) return AppState.proTeamSchedules.data;
    try {
        const cached = await browser.storage.session.get(key);
        if (cached && cached[key]) {
            AppState.proTeamSchedules = { key, data: cached[key] };
            return cached[key];
        }
    } catch { /* session storage unavailable, fall through to the network */ }
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}?view=proTeamSchedules_wl`;
        const data = await fetchEspnJson(url);
        AppState.proTeamSchedules = { key, data };
        try { await browser.storage.session.set({ [key]: data }); } catch { /* over quota, keep the memory copy */ }
        return data;
    } catch {
        AppState.proTeamSchedules = { key, data: null };
        return null;
    }
}

// The day's scoreboard, which is where ESPN carries betting lines. Public and UNAUTHENTICATED - validated, 200 with no cookies - on the same host the manifest wildcard already covers, so no new permission and no third party. Deliberately the DEFAULT response, with no ?dates=. Odds attach to ESPN's current SLATE, and that slate spans two UTC dates because night games roll past midnight Zulu; asking for a specific date returns those same games WITHOUT odds. Asking for "today" is the only query that carries them. NOT cached in session storage, unlike the season schedule. A line moves during the day, and a stale price shown as current is worse than no price. The in-memory copy is keyed by sport and hour so a render storm costs one fetch, not one per render. Failure is silent by design - the cards carry no line, which is what most of them do anyway.
export async function fetchScoreboardOdds() {
    const { sport, year } = getLeagueParams();
    const path = sport === 'fhl' ? 'hockey/nhl' : 'baseball/mlb';
    const key = `scoreboard:${sport}:${year}:${new Date().toISOString().slice(0, 13)}`;
    if (AppState.scoreboardOdds && AppState.scoreboardOdds.key === key) return AppState.scoreboardOdds.data;
    try {
        const data = await fetchEspnJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
        AppState.scoreboardOdds = { key, data };
        return data;
    } catch {
        AppState.scoreboardOdds = { key, data: null };
        return null;
    }
}

// One period's rosters, for the surface that needs the LAST lineup of a finished season. The league payload only carries current rosters while a matchup is live, so a completed season has none and this is the single call that answers it. Same validated parser the harvest uses.
export async function fetchRosterForPeriod(scoringPeriodId) {
    const { sport, leagueId, year } = getLeagueParams();
    return fetchRosterPeriod(sport, leagueId, year, scoringPeriodId);
}

// One scoring period's roster SNAPSHOT: every team's full roster with the lineupSlotId each player sat in on that exact day. mRoster with an explicit scoringPeriodId returns the historical lineup for a completed season (owner probe: periods 49 vs 50 differ by exactly the lineup edits applied on 50). Distilled to the shape the timeline consumes - [{ id, entries: [{ p, slot }] }] - so the pure module never sees ESPN's full playerPoolEntry payload. Defensive per golden rule 8: any missing field just drops that entry rather than throwing. The raw field names (teams[].id, roster.entries[].playerId,.lineupSlotId) are ESPN's standard mRoster shape; best-effort like the draft/transaction fetches, and a mismatch yields empty snapshots and the fallback ladder.
async function fetchRosterPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mRoster&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        return (data && data.teams || []).map(t => ({
            id: t.id,
            entries: ((t.roster && t.roster.entries) || [])
                .map(e => ({ p: e.playerId, slot: e.lineupSlotId }))
                .filter(e => e.p != null && e.slot != null)
        }));
    } catch {
        return [];
    }
}

// Harvest the whole season's daily roster snapshots, one request per scoring period, into { days: { period: [{ id, entries }] } }. Same shape and cost as harvestTransactions - one request per period, concurrency-capped so a ~196-request season reads as normal browsing - and cached for the session by the caller (players.js). This is what upgrades the race from rostered-accurate to STARTED-accurate. The snapshot says not just who owned a player but whether he was in a starting slot that day, which is exactly the distinction ESPN's own standings count.
export async function harvestRosters(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);

    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchRosterPeriod(sport, leagueId, year, period));

    const days = {};
    periods.forEach((period, i) => {
        const teams = slices[i] || [];
        if (teams.length) days[period] = teams;
    });
    return { days };
}

// data.status.previousSeasons turned out to not be scoped to the specific league being queried (a baseball league starting in 2025 was showing years back to 2021 - almost certainly bleeding in from a different league/sport tied to the same ESPN account). The leagueHistory endpoint is scoped to this exact sport+leagueId and returns one entry per season the league itself has actually existed for, so it's the correct source of truth. Best-effort only: a brand-new league with no history yet, or a private league returning a 404/empty result here, should never block the main fetch.
async function fetchLeagueHistorySeasons(sport, leagueId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/leagueHistory/${leagueId}`;
        const seasons = await fetchEspnJson(url);
        // Captured for the diagnostic panel so the ARRAY's shape can be read off a real league. Whether its entries carry full season payloads or only stubs is the one thing League History could not verify offline (docs/DATA-SOURCES.md section 9).
        setDebugContext('league-history', seasons);
        return (seasons || []).map(s => s.seasonId).filter(Boolean);
    } catch {
        return [];
    }
}

// One past season's league payload, for League History ( M1). The SAME views the current season fetches, because history reads the same fields: teams for franchise identity and final ranks, schedule for the bracket champion and the head-to-head grid, settings for the season's scoring format and its category set. leagueHistory itself is only asked WHICH years exist (fetchLeagueHistorySeasons above). Whether its array entries also carry full payloads is unverified against a real league, so this fetches each season directly rather than trusting a shape nobody has measured - see docs/DATA-SOURCES.md section 9. If that array does turn out to carry everything, this becomes the fallback rather than the path.
export async function fetchSeasonPayload(sport, leagueId, year) {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam&view=mMatchupScore&view=mSettings`;
    return fetchEspnJson(url);
}

// Session-cached per season. A history view that is opened, left and reopened must not refetch a finished season whose numbers cannot change, and the cache is per league so switching leagues cannot serve one league's past under another's name.
const seasonCache = new Map();
export function resetSeasonCache() { seasonCache.clear(); poolCache.clear(); }

export async function loadHistorySeasons(sport, leagueId, years, onProgress) {
    const wanted = [...new Set(years || [])].filter(Boolean).sort((a, b) => a - b);
    const payloads = {};
    let done = 0;
    for (const year of wanted) {
        const key = `${sport}:${leagueId}:${year}`;
        if (!seasonCache.has(key)) {
            try {
                seasonCache.set(key, await fetchSeasonPayload(sport, leagueId, year));
            } catch {
                // One unreadable season never costs the others. It is absent from the history, which the view reports as a season it could not read.
                seasonCache.set(key, null);
            }
        }
        const payload = seasonCache.get(key);
        if (payload) payloads[year] = payload;
        done += 1;
        if (onProgress) onProgress(done, wanted.length);
    }
    return payloads;
}

// One past season's PLAYER POOL, for the career table ( M4). Deliberately the most expensive thing League History can ask for, and so the only thing it never asks for on its own: the tab's champions, standings, head-to-head and category tables are built from the league payloads above and must never wait on this. It runs when the career table is opened, and not before. The filter is narrow for a measured reason. A capture taken with the daily splits left in is 52 MB per season; the same league filtered to season totals is 4.1 MB. Both axes are honoured - the filtered capture came back with no split-5 blocks at all - so this asks for source 0 (real, not projected, which for a finished season is the only kind that means anything) split 0 (the season total). See docs/DATA-SOURCES.md section 9.
export async function fetchSeasonPool(sport, leagueId, year) {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=kona_player_info`;
    const filter = {
        players: {
            limit: 3000,
            sortPercOwned: { sortPriority: 1, sortAsc: false },
            filterStatsForSourceIds: { value: [0] },
            filterStatsForSplitTypeIds: { value: [0] }
        }
    };
    return fetchEspnJson(url, filter);
}

const poolCache = new Map();

export async function loadHistoryPools(sport, leagueId, years, onProgress) {
    const wanted = [...new Set(years || [])].filter(Boolean).sort((a, b) => a - b);
    const pools = {};
    let done = 0;
    for (const year of wanted) {
        const key = `${sport}:${leagueId}:${year}`;
        if (!poolCache.has(key)) {
            try {
                poolCache.set(key, await fetchSeasonPool(sport, leagueId, year));
            } catch {
                // Same rule as the season payloads: one unreadable year is one year missing from the careers, not a dead table.
                poolCache.set(key, null);
            }
        }
        const pool = poolCache.get(key);
        if (pool) pools[year] = pool;
        done += 1;
        if (onProgress) onProgress(done, wanted.length);
    }
    return pools;
}

// EVERY FRANCHISE THAT HELD A PLAYER, per season ( item 5). The careers table's franchise column used to read the pool's onTeamId, which is the roster at the moment of the fetch - so a player who was dropped before it attributed to nobody, and the owner's drafted-and-held case showed only the season he happened to still be rostered in. THE COST, measured across the fixture set: the transaction log is one request per scoring period (ESPN scopes mTransactions2 to the current period unless asked otherwise, and batching through X-Fantasy-Filter returns zero rows - both established in the probes). That is 187 to 196 requests per season, so a five-season league is close to a thousand. Three things keep it honest: 1. It is LAZY, behind the careers pane, which is already the one part of this tab that pays for anything. Nobody who never opens careers fetches a single transaction. 2. The live season reuses the log the Roto Race already harvested when it is in hand, which is the ~192 requests most often already spent. 3. It is cached per season for the session, like the pools beside it. A season whose log cannot be read falls back to onTeamId rather than blanking the column, which is golden rule 8: the old answer was incomplete, not wrong, so an unreadable year degrades to it.
const ownershipCache = new Map();

// ONE SHARED LIMITER ACROSS SEASONS ( item 1). The old shape walked seasons in a for..of with an await, so each season's 190 requests drained to zero before the next one's first request went out - and the gap at the end of every season is dead time no cap requires. WHAT THIS DOES NOT DO, said plainly because the entry hoped for it: three seasons cannot approach the wall-clock of one. The cap is 6 TOTAL and the request count is unchanged, so the floor is still (seasons x periods) / 6 waves. What sharing the limiter buys is the drain gap between seasons and nothing more. The change that makes the pane usable is the draft-first render below, which puts a full table on screen after one request per season instead of after all of them. Tasks are queued season by season rather than round-robin, deliberately: the limiter then finishes the seasons IN ORDER, so per-season progressive fill still lands one season at a time instead of every season completing together at the very end.
export async function loadHistoryOwnership(sport, leagueId, years, payloadsByYear, options = {}) {
    const { onDrafts, onSeason, onProgress, liveSeason } = options;
    const wanted = [...new Set(years || [])].filter(Boolean).sort((a, b) => a - b);

    const owners = {};
    const pending = [];

    // Anything already in hand resolves without a request: a season harvested earlier this session, or the live one the Roto Race has already paid for.
    for (const year of wanted) {
        const key = `${sport}:${leagueId}:${year}`;
        if (ownershipCache.has(key)) {
            const cached = ownershipCache.get(key);
            if (cached) owners[year] = cached;
            continue;
        }
        if (liveSeason && liveSeason.year === year && liveSeason.picks && liveSeason.transactions) {
            const map = ownerTeamIdsByPlayer(buildRosterTimeline(liveSeason));
            ownershipCache.set(key, map);
            owners[year] = map;
            continue;
        }
        pending.push(year);
    }
    if (!pending.length) {
        if (onDrafts) onDrafts(owners, []);
        return owners;
    }

    // PHASE 1: the drafts, one request per season, all of them through the shared limiter. This is the cheap half and it attributes every player who was drafted and never moved - which in a quiet league is most of them.
    const picksByYear = {};
    const draftResults = await runWithConcurrencyLimit(pending, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (year) => fetchDraftDetail(sport, leagueId, year));
    pending.forEach((year, i) => { picksByYear[year] = draftResults[i] || []; });

    // THE DRAFT MAPS GO STRAIGHT INTO `owners`. built them in a separate object and handed that to onDrafts, which left `owners` holding only cached and finished seasons - so the first season's log to land published a map with every OTHER pending season MISSING, and buildCareers fell those columns back to the pool's onTeamId. That is the season-end snapshot item 5 measured wrong for most of a pool, so the table regressed to the exact bug fixed, mid-refinement, while the note above it still said the franchises came from the draft. One map, seeded here and overwritten season by season in finish(), makes the intermediate states impossible to get wrong rather than merely correct today. It needs two-plus uncached seasons to show at all, which is how it survived B173's single-season pass.
    pending.forEach(year => {
        const picks = picksByYear[year];
        if (picks.length) owners[year] = ownerTeamIdsByPlayer(buildRosterTimeline({ picks }));
    });
    // The table can render now, on draft-based attribution, while the log is still coming. The pending list rides along so the caller can say how many seasons are still refining without guessing - a cached season never appears in it.
    if (onDrafts) onDrafts(owners, [...pending]);

    // PHASE 2: every (season, period) pair as ONE task list through the SAME limiter.
    const tasks = [];
    pending.forEach(year => {
        const status = ((payloadsByYear && payloadsByYear[year]) || {}).status || {};
        const first = status.firstScoringPeriod;
        const final = status.finalScoringPeriod;
        // No period bounds means nothing to walk. That season keeps its draft-only attribution, which is the golden rule 8 answer rather than a blank column.
        if (!Number.isFinite(first) || !Number.isFinite(final)) return;
        for (let period = first; period <= final; period++) tasks.push({ year, period });
    });

    const remaining = new Map();
    const txByYear = {};
    pending.forEach(year => { txByYear[year] = []; });
    tasks.forEach(t => remaining.set(t.year, (remaining.get(t.year) || 0) + 1));

    const finish = (year) => {
        const key = `${sport}:${leagueId}:${year}`;
        const picks = picksByYear[year] || [];
        // De-duplicated by id because ESPN can echo a multi-period transaction into more than one period slice - the same rule harvestTransactions applied when it owned this.
        const byId = new Map();
        (txByYear[year] || []).forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
        const transactions = [...byId.values()];
        const map = (picks.length || transactions.length)
            ? ownerTeamIdsByPlayer(buildRosterTimeline({ picks, transactions }))
            : null;
        ownershipCache.set(key, map);
        // null only when the season had neither picks nor transactions - and a season with no picks was never seeded above, so the fallback contract is unchanged: nothing to overwrite, and the year stays absent so buildCareers uses onTeamId for it.
        if (map) owners[year] = map;
        if (onSeason) onSeason(year, owners);
    };

    // A season with no periods to walk is done the moment its draft is in.
    pending.filter(year => !remaining.has(year)).forEach(finish);

    let done = 0;
    await runWithConcurrencyLimit(tasks, WEEKLY_MAX_CONCURRENT_CHUNKS, async (task) => {
        const slice = await fetchTransactionPeriod(sport, leagueId, task.year, task.period);
        if (slice.length) txByYear[task.year].push(...slice);
        done += 1;
        if (onProgress) onProgress(done, tasks.length);
        const left = (remaining.get(task.year) || 0) - 1;
        remaining.set(task.year, left);
        if (left === 0) finish(task.year);
    });

    return owners;
}

// Runs after EVERY successful fetchEspnData, whoever started it: the Fetch Data button, the My Leagues picker's auto-fetch above, or anything added later. Registered once from main.js rather than called directly here because the work it does (reloading the Player Metrics view) lives in players.js, and api.js importing players.js would be circular - players.js already imports this module's fetch helpers. Routing it through fetchEspnData instead of the individual initiators is the point. The picker path silently missed the button's player-view reload for exactly as long as that reload lived in the button handler, and a registered hook means the next fetch initiator inherits it instead of having to remember.
let postFetchHook = null;
export function setPostFetchHook(fn) { postFetchHook = fn; }

export async function fetchEspnData() {
    const { sport, leagueId, year } = getLeagueParams();

    if (!leagueId) return alert("Enter a League ID.");
    await browser.storage.local.set({ sport, leagueId, year });

    // Snapshotted before processCoreData() wipes it below. A drill-down that's open right now should reopen against the league/year just fetched rather than silently disappearing. The capture has to happen here, not in the caller, because the picker's auto-fetch calls straight into this function with no chance for anything else to read the id first.
    const reopenPlayerId = AppState.selectedPlayerId;

    const btn = document.getElementById('fetch-btn');
    btn.textContent = "Fetching...";
    btn.disabled = true;

    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam&view=mMatchupScore&view=mSettings&view=mBoxscore`;

    let succeeded = false;
    try {
        const data = await fetchEspnJson(url);

        setDebugContext('team', data);
        AppState.apiData = data;
        AppState.leagueDataError = null;
        AppState.leagueHistoryYears = await fetchLeagueHistorySeasons(sport, leagueId);
        await browser.storage.session.set({ apiData: data, leagueHistoryYears: AppState.leagueHistoryYears });
        processCoreData();
        succeeded = true;
    } catch (error) {
        // A private league read with no cookies fails outright, unlike a restrictionType NONE one. Recorded so the login watcher can retry it, and phrased as the action rather than the status, the same rule the player pool follows.
        AppState.leagueDataError = error.authRequired ? { authRequired: true } : null;
        alert(error.authRequired
            ? 'Log into ESPN in this browser, then fetch again.'
            : `Error: ${error.message}`);
    } finally {
        btn.textContent = "Fetch Data";
        btn.disabled = false;
    }

    // Outside the try on purpose. A failure inside the hook is a rendering problem, and reporting it through the catch above would show it as "Error:..." as though the fetch itself failed. Running it after the finally also means the button is usable again even if the refresh is slow.
    if (succeeded && postFetchHook) await postFetchHook({ reopenPlayerId });
}
