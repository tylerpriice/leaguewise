import { AppState } from './state.js';
import { setDebugContext, escapeHtml } from './utils.js';
import { processCoreData } from './data.js';

export async function checkAuth() {
    const s2Cookie = await browser.cookies.get({ url: 'https://espn.com', name: 'espn_s2' });
    const swidCookie = await browser.cookies.get({ url: 'https://espn.com', name: 'SWID' });
    const authStatus = document.getElementById('auth-status');

    if (s2Cookie && swidCookie) {
        // Success needs no banner. Only a missing-cookies problem is worth surfacing.
        authStatus.textContent = '';
        authStatus.style.display = 'none';
        // Remember the SWID so the weekly recap can auto-pick "my team" (matches team owners).
        AppState.userSwid = swidCookie.value || '';
        // Fire-and-forget league discovery. The manual sport/league-id/year fields work exactly as before whether or not this succeeds.
        populateLeaguePicker(swidCookie.value).catch(() => {});
    } else {
        authStatus.style.display = '';
        authStatus.textContent = '❌ Missing Cookies. Log into ESPN Fantasy first.';
        authStatus.className = 'status-red';
    }
}

// ESPN's fan-profile endpoint knows every fantasy league the logged-in account belongs to. Keyed by the SWID cookie, authenticated by the same espn_s2 cookie every other call here already uses (fan.api.espn.com is under the .espn.com cookie domain and the extension's existing *.espn.com host permission). gameId mapping per entry: 1=ffl, 2=flb, 3=fba, 4=fhl.
const FAN_API_GAME_IDS = { 1: 'ffl', 2: 'flb', 3: 'fba', 4: 'fhl' };
const SUPPORTED_SPORTS = new Set(['flb', 'fhl']);

export async function populateLeaguePicker(swid) {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;

    const data = await fetchEspnJson(`https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`);

    // Keyed by sport:leagueId, not season. The fan API can list the same league once per season it knows about, so this keeps only the highest seasonId per league, which matches what the onchange handler below auto-selects in the Year dropdown.
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
        byLeague.set(key, {
            leagueId,
            sport,
            seasonId: entry.seasonId,
            label: `${group.groupName || entry.name || `League ${leagueId}`} (${sport === 'flb' ? 'MLB' : 'NHL'})`
        });
    });
    const leagues = Array.from(byLeague.values());
    if (leagues.length === 0) return;

    select.innerHTML = '<option value="">Choose...</option>' +
        leagues.map((l, i) => `<option value="${i}">${escapeHtml(l.label)}</option>`).join('');
    wrap.style.display = '';

    select.onchange = () => {
        // Guard the "Choose..." placeholder explicitly. Its value is '', and Number('') is 0, which would otherwise silently select the first league.
        if (select.value === '') return;
        const league = leagues[Number(select.value)];
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
        // This restore path (reopening the extension on an already-loaded session) never went through fetchEspnData, so the debug panel's 'team' context was staying permanently empty until the next manual "Fetch Data" click. Only ever populated on a fresh fetch.
        setDebugContext('team', session.apiData);
        processCoreData();
    }
}

// Reads the sport/league/year the user has entered. The same three fields every ESPN fantasy API call in this file needs to build its URL.
function getLeagueParams() {
    return {
        sport: document.getElementById('sport').value,
        leagueId: document.getElementById('league-id').value,
        year: document.getElementById('year').value
    };
}

// Runs `worker` over every item in `items`, at most `limit` calls in flight at once. Fails fast on the first rejection, same as Promise.all would.
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

// Shared fetch/throw/parse for an ESPN fantasy API call. Every endpoint here sends cookies via credentials:'include' and, when filtering the response server-side, an X-Fantasy-Filter header.
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
    // Delegates to the bulk endpoint below with a single id. Same request shape (and same { players: [...] } response shape, since processPlayerWeeklyHistory already flattens across however many entries rawData.players holds), one less code path to keep in sync.
    return fetchPlayersWeeklyStatsBulk([playerId]);
}

// Fetches weekly/daily stat history for MANY players in one shot, instead of one HTTP request per player. Needed to make the Player Metrics leaderboard timeframe-aware (see getEffectivePlayerPool in players.js) without one request per player in the pool.
const CHUNK_SIZE = 75;
const MAX_CONCURRENT_CHUNKS = 6;

export async function fetchPlayersWeeklyStatsBulk(playerIds) {
    const { sport, leagueId, year } = getLeagueParams();
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=kona_player_info`;

    const chunks = [];
    for (let i = 0; i < playerIds.length; i += CHUNK_SIZE) {
        chunks.push(playerIds.slice(i, i + CHUNK_SIZE));
    }

    const responses = await runWithConcurrencyLimit(chunks, MAX_CONCURRENT_CHUNKS, chunk => fetchEspnJson(url, {
        players: {
            filterIds: { value: chunk },
            filterStatsForSourceIds: { value: [0, 1] },
            filterStatsForTopScoringPeriodIds: { value: 2000, additionalValue: [`00${year}`, `01${year}`] }
        }
    }));

    // Merge every chunk's players array into one combined response shape. The caller doesn't need to know this was chunked at all.
    return { players: responses.flatMap(r => r.players || []) };
}

// data.status.previousSeasons turned out to not be scoped to the specific league being queried (a baseball league starting in 2025 was showing years back to 2021, almost certainly bleeding in from a different league/sport tied to the same ESPN account).
async function fetchLeagueHistorySeasons(sport, leagueId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/leagueHistory/${leagueId}`;
        const seasons = await fetchEspnJson(url);
        return (seasons || []).map(s => s.seasonId).filter(Boolean);
    } catch {
        return [];
    }
}

export async function fetchEspnData() {
    const { sport, leagueId, year } = getLeagueParams();

    if (!leagueId) return alert("Enter a League ID.");
    await browser.storage.local.set({ sport, leagueId, year });

    const btn = document.getElementById('fetch-btn');
    btn.textContent = "Fetching...";
    btn.disabled = true;

    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam&view=mMatchupScore&view=mSettings&view=mBoxscore`;

    try {
        const data = await fetchEspnJson(url);

        setDebugContext('team', data);
        AppState.apiData = data;
        AppState.leagueHistoryYears = await fetchLeagueHistorySeasons(sport, leagueId);
        await browser.storage.session.set({ apiData: data, leagueHistoryYears: AppState.leagueHistoryYears });
        processCoreData();
    } catch (error) {
        alert(`Error: ${error.message}`);
    } finally {
        btn.textContent = "Fetch Data";
        btn.disabled = false;
    }
}