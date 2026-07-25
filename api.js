import { AppState } from './state.js';
import { setDebugContext, escapeHtml } from './utils.js';
import { processCoreData } from './data.js';

export async function checkAuth() {
    const s2Cookie = await browser.cookies.get({ url: 'https://espn.com', name: 'espn_s2' });
    const swidCookie = await browser.cookies.get({ url: 'https://espn.com', name: 'SWID' });
    const authStatus = document.getElementById('auth-status');

    if (s2Cookie && swidCookie) {
        // Only a missing-cookies problem is worth a banner.
        authStatus.textContent = '';
        authStatus.style.display = 'none';
        // Remember the SWID so the recap can pre-select the user's own team.
        AppState.userSwid = swidCookie.value || '';
        // Fire and forget: the manual sport, league id and year fields work whether or not discovery succeeds.
        populateLeaguePicker(swidCookie.value).catch(() => {});
    } else {
        authStatus.style.display = '';
        authStatus.textContent = '❌ Missing Cookies. Log into ESPN Fantasy first.';
        authStatus.className = 'status-red';
    }
}

// ESPN's fan-profile endpoint lists every fantasy league the logged-in account belongs to, keyed by the SWID cookie and authenticated by the same espn_s2 cookie every other call here uses (gameId 1=ffl, 2=flb, 3=fba, 4=fhl). Parsed defensively field by field, and any failure just leaves the picker hidden.
const FAN_API_GAME_IDS = { 1: 'ffl', 2: 'flb', 3: 'fba', 4: 'fhl' };
const SUPPORTED_SPORTS = new Set(['flb', 'fhl']);

// The last successful discovery is kept in memory so a sport change re-renders the picker without re-fetching.
let discoveredLeagues = [];

export async function populateLeaguePicker(swid) {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;

    const data = await fetchEspnJson(`https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`);

    // Keyed by sport:leagueId rather than season, because the fan API can list the same league once per season it knows about. The highest seasonId is kept, which is also the year the change handler auto-selects.
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
        // No season or sport in the label: the Year dropdown owns the year, and the picker is already filtered to the selected sport.
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
        // The placeholder's value is empty and matches no league.
        if (select.value === '') return;
        // Values are stable sport:leagueId keys rather than list indices, so the lookup survives a sport-filtered re-render.
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

// Renders the picker filtered to the selected sport. Rebuilding the option set fires no change event, so a selection from another sport resets to the placeholder without fetching anything.
export function renderMyLeaguesOptions() {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;
    const currentSport = document.getElementById('sport').value;
    const forSport = discoveredLeagues.filter(l => l.sport === currentSport);
    if (forSport.length === 0) {
        // Nothing discovered for this sport, so hide the picker. Manual league-id entry still works.
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
        // The restore path never goes through fetchEspnData, so without this the debug panel's team context stays empty until the next manual fetch.
        setDebugContext('team', session.apiData);
        processCoreData();
    }
}

// The three fields every ESPN fantasy API call here needs to build its URL.
function getLeagueParams() {
    return {
        sport: document.getElementById('sport').value,
        leagueId: document.getElementById('league-id').value,
        year: document.getElementById('year').value
    };
}

// Runs worker over items with at most `limit` calls in flight, failing fast on the first rejection.
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

// Shared fetch, throw and parse. Every endpoint sends cookies with credentials include, plus an X-Fantasy-Filter header when filtering server-side, and a non-ok response is worth a real Error rather than a broken body.
async function fetchEspnJson(url, filter) {
    const headers = filter ? { 'X-Fantasy-Filter': JSON.stringify(filter) } : {};
    const response = await fetch(url, { credentials: 'include', headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
    // Delegates to the bulk endpoint with a single id, so there is one request shape to keep in sync instead of two.
    return fetchPlayersWeeklyStatsBulk([playerId]);
}

// Weekly stat history for many players at once, chunked because a single request with hundreds of ids risks an unreasonable URL and response, and capped in flight so a deep pool does not fire ten simultaneous requests at ESPN. filterStatsForTopScoringPeriodIds is set well past a season's day count so daily-scoring sports are never truncated.
export const WEEKLY_CHUNK_SIZE = 75;
export const WEEKLY_MAX_CONCURRENT_CHUNKS = 6;

// One request for one chunk of ids, the unit the leaderboard's queue schedules, so a scroll or re-sort can change what the next chunk asks for. A drill-down fetch goes through the bulk helper instead and never waits behind a chunk.
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

    // Merge every chunk's players array so the caller never needs to know this was chunked.
    return { players: responses.flatMap(r => r.players || []) };
}

// Draft picks are the day-one rosters, fetched with mDraftDetail since the main league call does not request that view. Returns an empty array when the league has no draft detail.
export async function fetchDraftDetail(sport, leagueId, year) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mDraftDetail`;
        const data = await fetchEspnJson(url);
        return (data && data.draftDetail && data.draftDetail.picks) || [];
    } catch {
        return [];
    }
}

// mTransactions2 silently scopes to the CURRENT period unless an explicit scoringPeriodId is passed, which is why the plain call reads empty for a completed season. Batching periods through the filter returns no rows, so the harvest is genuinely one request per period.
async function fetchTransactionPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTransactions2&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        return (data && data.transactions) || [];
    } catch {
        return [];
    }
}

// The whole season's transaction log, one request per scoring period, concurrency-capped so a 196-request season reads as normal browsing. De-duplicated by transaction id, since ESPN can echo a multi-period transaction into more than one slice.
export async function harvestTransactions(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);

    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchTransactionPeriod(sport, leagueId, year, period));

    const byId = new Map();
    slices.flat().forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
    return Array.from(byId.values());
}

// One period's roster snapshot: every team's roster with the lineupSlotId each player sat in that day. Distilled to [{ id, entries: [{ p, slot }] }] so the pure module never sees ESPN's full payload, and any missing field drops that entry rather than throwing.
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

// The season's daily roster snapshots, same shape and cost as the transaction harvest. This is what makes the race started-accurate rather than only rostered-accurate, since the snapshot says whether a player was in a starting slot that day.
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

// status.previousSeasons is not scoped to the league being queried and can list years belonging to other leagues on the same account. leagueHistory is scoped to this exact sport and league id, and stays best-effort so a new or private league never blocks the main fetch.
async function fetchLeagueHistorySeasons(sport, leagueId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/leagueHistory/${leagueId}`;
        const seasons = await fetchEspnJson(url);
        return (seasons || []).map(s => s.seasonId).filter(Boolean);
    } catch {
        return [];
    }
}

// Runs after every successful fetch, whoever started it. Registered from main.js rather than called here, because the work lives in players.js and api.js importing players.js would be circular.
let postFetchHook = null;
export function setPostFetchHook(fn) { postFetchHook = fn; }

export async function fetchEspnData() {
    const { sport, leagueId, year } = getLeagueParams();

    if (!leagueId) return alert("Enter a League ID.");
    await browser.storage.local.set({ sport, leagueId, year });

    // Snapshotted before processCoreData wipes it, so a drill-down that is open right now reopens against the league just fetched.
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
        AppState.leagueHistoryYears = await fetchLeagueHistorySeasons(sport, leagueId);
        await browser.storage.session.set({ apiData: data, leagueHistoryYears: AppState.leagueHistoryYears });
        processCoreData();
        succeeded = true;
    } catch (error) {
        alert(`Error: ${error.message}`);
    } finally {
        btn.textContent = "Fetch Data";
        btn.disabled = false;
    }

    // Outside the try on purpose: a failure in the hook is a rendering problem, and reporting it through the catch would read as though the fetch itself failed.
    if (succeeded && postFetchHook) await postFetchHook({ reopenPlayerId });
}
