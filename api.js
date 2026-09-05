import { AppState } from './state.js';
import { setDebugContext, hasDebugContext, setDebugLoading, escapeHtml, countApiRequest, leagueSeasonYears } from './utils.js';
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
        // The moment a logged-out session becomes a logged-in one, which the watchers already detect within a focus or a cookie change. Anything that failed for want of a login can now succeed, so say so and let main.js decide what to reload - api.js importing players.js would close a cycle (see the post-fetch hook below for the same reasoning). Fires on a normal logged-in load too, where the handler finds nothing broken and stops.
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
// Football joins so league discovery lists ffl leagues and the picker can select one. Every league URL in this file is already `games/${sport}/...`, so the endpoint family needs nothing - what ffl does NOT yet have is validated stat ids, and the surfaces degrade explicitly for that rather than this gate pretending the sport is absent.
const SUPPORTED_SPORTS = new Set(['flb', 'fhl', 'ffl']);

// The full cross-sport league list from the last successful discovery, kept in memory so a #sport change can re-render the picker filtered to the selected sport without re-fetching the fan API.
let discoveredLeagues = [];

export async function populateLeaguePicker(swid) {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;

    // One discovery per BROWSER session, not per page open. The league list changes when the user joins a league, which is not a mid-afternoon event; keyed by SWID so a login switch never shows the previous account's leagues. Falls through to the network on any miss.
    const discoveryKey = `discoveredLeagues:${swid}`;
    try {
        const cached = await browser.storage.session.get(discoveryKey);
        if (Array.isArray(cached[discoveryKey]) && cached[discoveryKey].length) {
            discoveredLeagues = cached[discoveryKey];
            wireLeaguePicker(select);
            renderMyLeaguesOptions();
            return;
        }
    } catch { /* no session storage - discover as before */ }

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
    try { await browser.storage.session.set({ [discoveryKey]: discoveredLeagues }); } catch { /* memory copy still works */ }

    wireLeaguePicker(select);
    renderMyLeaguesOptions();
}

function wireLeaguePicker(select) {
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
        // The cached paint is up; now go and find out whether it is still true. Deliberately NOT awaited - the whole point is that the restore stays instant.
        revalidateLeagueData();
    }
}

// STALE-WHILE-REVALIDATE for the league payload. The restore above paints from browser.storage.session, which survives until the BROWSER closes, not until the tab does. So a browser left open all day served the morning's payload on every dashboard open, and the owner watched a live matchup read "tied" from breakfast to bedtime on the store build and a local one alike. It is original behaviour rather than a regression: the restore path has never refetched, and "Live Scoreboard" is a promise it has never kept. The fix is one background read of the same league, after the cached view is already on screen. Cheap - one request per dashboard open, which is what every user already believes is happening - and invisible when nothing has moved. A REVALIDATE THAT FAILS CHANGES NOTHING. Offline, logged out, ESPN having a bad minute: the cache stays on screen and nothing is said, because the user did not ask for a refresh and cannot act on its failure. The error states that exist are for actions somebody took. THE FIVE-MINUTE GATE. A reopen within LEAGUE_REVALIDATE_MIN_MS of the last successful league fetch paints the cache and sends nothing: the ruled freshness budget is five minutes, chosen to match CloudFront's own declared max-age, so a revalidate inside that window could not learn anything the CDN would not also say. A gated revalidate is indistinguishable from a failed one - nothing changes on screen - which is already the designed failure mode. Manual paths (Fetch Data, the picker, the login retry) never come through here and never gate.
const LEAGUE_REVALIDATE_MIN_MS = 300000;

async function revalidateLeagueData() {
    const { sport, leagueId, year } = getLeagueParams();
    if (!leagueId) return;

    try {
        const gate = await browser.storage.session.get(['lastLeagueFetchKey', 'lastLeagueFetchAt']);
        if (gate.lastLeagueFetchKey === `${sport}:${leagueId}:${year}`
            && Date.now() - (gate.lastLeagueFetchAt || 0) < LEAGUE_REVALIDATE_MIN_MS) return;
    } catch { /* no session storage, no gate - revalidate as before */ }

    // What the screen is showing right now, captured before the await. If the user presses Fetch Data, or the year picker auto-fetches, while this request is in flight, the answer coming back is for a league nobody is looking at any more - and writing it in would replace the league they just chose with the one they left. Cheaper and more certain than cancelling.
    const shownSeason = AppState.apiData?.seasonId;
    const shownLeague = AppState.apiData?.id;

    try {
        const data = await fetchEspnJson(leagueUrl(sport, leagueId, year));
        if (AppState.apiData?.seasonId !== shownSeason || AppState.apiData?.id !== shownLeague) return;

        AppState.apiData = data;
        AppState.leagueDataError = null;
        setDebugContext('team', data);
        // The history years are a separate, slower call and do not go stale within a day - the cached list is written back so the session entry stays whole rather than losing a field.
        await browser.storage.session.set({
            apiData: data, leagueHistoryYears: AppState.leagueHistoryYears,
            lastLeagueFetchKey: `${sport}:${leagueId}:${year}`, lastLeagueFetchAt: Date.now()
        });
        processCoreData({ revalidate: true });
    } catch {
        // Nothing. See the note above.
    }
}

// The league payload's URL, in one place. The revalidate has to ask for exactly what the fetch asks for - a revalidate that requested fewer views would hand processCoreData a payload missing the half it needs and quietly blank a working dashboard.
function leagueUrl(sport, leagueId, year) {
    return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam&view=mMatchupScore&view=mSettings&view=mBoxscore`;
}

// Reads the sport/league/year the user has entered - the same three fields every ESPN fantasy API call in this file needs to build its URL.
function getLeagueParams() {
    return {
        sport: document.getElementById('sport').value,
        leagueId: document.getElementById('league-id').value,
        year: document.getElementById('year').value
    };
}

// Runs `worker` over every item in `items`, at most `limit` calls in flight at once - fails fast on the first rejection, same as Promise.all would. PACING: the cap bounds PARALLELISM but never bounded RATE - six lanes cycling fast answers drain a 194-period season at ~25 requests a second for half a minute, and that burst profile is the scraper signature whatever the total. Callers with three-digit fan-outs pass `pacing`, and each lane sleeps paceMs plus up to jitterMs after every item: six lanes at 900+0..300ms land near five requests a second. Short queues (a dozen weekly chunks) stay unpaced - a one-second blip is not a signature. THE THROTTLE GATE: a worker that throws `throttled` (fetchEspnJson's 429/Retry-After shape) pauses EVERY lane behind one shared gate for retryAfterMs, then retries that item - slowing down being the entire point of the signal. Three pauses per queue run; a queue still throttled after that stops retrying and hands the item `undefined`, which every fan-out consumer already treats as its empty fallback - the harvest completes late or degrades exactly as an unreadable period always has (golden rule 8), and never fails the whole queue. A REFUSAL is the host declining to answer AT ALL, and it is the only failure a circuit breaker should act on. Two shapes, both named by fetchEspnJson: `throttled` (429, or any 4xx carrying a positive Retry-After - see throttleOf) and `authRequired` (401/403/405 without one). Everything else stays per-request: a period that 404s, a body that will not parse, a season ESPN has no log for. Those are the unreadable-period case golden rule 8 already answers by degrading, and one of them says nothing about the next request. DELIBERATELY NOT COVERED: being offline. A dead network throws a bare TypeError, which the per-period workers swallow into an empty slice, so the breaker never sees it and a walk run with no connection still issues every request. Covering it means rethrowing network errors out of those workers, which changes what an ordinary unreadable period does, and that is a wider change than this one. Named here so the gap is known rather than assumed shut.
const isRefusal = (e) => !!(e && (e.throttled || e.authRequired));

// FIVE, and the number is the argument. One refusal is ordinary and always has been. Five IN A ROW cannot be a property of five particular scoring periods - with six lanes in flight it means every answer coming back is a refusal - so the wall is the host's, and the next 190 requests would all be refused too. Before this, they were all sent: fetchTransactionPeriod swallowed the failure, runWithConcurrencyLimit issued the rest regardless, and a season whose first twenty periods were refused still spent the other ~175 asking a host that had already said no. That is the opposite of backing off, and it is the failure mode that matters if a lockout was ever rate-limiting.
const REFUSALS_BEFORE_STOP = 5;

// `breaker` is optional and opt-in: { stopAfter, onTrip }. Without it the behaviour below is exactly what it was, which is why only the three per-period walks pass one.
async function runWithConcurrencyLimit(items, limit, worker, pacing, breaker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let gate = null;
    let pausesLeft = 3;
    let refusals = 0;
    let tripped = false;

    // Counted, and at the threshold the queue stops HANDING OUT work - the lanes still finish what they are holding, so nothing is abandoned mid-flight and every result already in hand is kept. The item that tripped it, and every item never started, take `undefined`, which every fan-out consumer here already treats as its empty fallback.
    const refuse = (e) => {
        if (!breaker) return undefined;
        refusals += 1;
        if (refusals >= breaker.stopAfter && !tripped) {
            tripped = true;
            nextIndex = items.length;
            if (breaker.onTrip) breaker.onTrip(e);
        }
        return undefined;
    };

    async function attempt(i) {
        try {
            const out = await worker(items[i], i);
            refusals = 0; // any real answer means the host is talking again
            return out;
        } catch (e) {
            if (!e || !e.throttled) {
                if (breaker && isRefusal(e)) return refuse(e);
                throw e;
            }
            if (pausesLeft <= 0) return refuse(e);
            if (!gate) {
                pausesLeft -= 1;
                const wait = Math.min(Math.max(e.retryAfterMs || 30000, 1000), 300000);
                gate = sleep(wait).then(() => { gate = null; });
            }
            await gate;
            return attempt(i);
        }
    }

    async function runNext() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            if (gate) await gate;
            results[i] = await attempt(i);
            if (pacing && pacing.paceMs) await sleep(pacing.paceMs + Math.random() * (pacing.jitterMs || 0));
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
    return results;
}

// The BACKGROUND pacing profile, stated once so the arithmetic is auditable: six lanes, each pausing 900-1200ms between items, is 6 / ~1.15s = ~5 requests a second against the ~25 an unpaced drain measured. A 194-period season completes in ~40 seconds. Since nothing runs in this lane. Its last two callers, the race's roster harvests, turned out to have no background trigger at all (the race is the only caller and it is on screen), so they moved to the foreground lane below. It stays defined, with its setter, for the next harvest that IS started behind the user's back - that one takes this profile, not the fast one. A `let` with a setter rather than a const, for the HARNESS only: a staged harvest answers off disk in a millisecond, so a measurement of anything else would drown in half a minute of deliberate sleeping unless it can zero this first. Nothing in the app changes it.
let FAN_OUT_PACING = { paceMs: 900, jitterMs: 300 };

// The FOREGROUND lane. A user sitting on the careers pane watching the spinner is a different situation from a harvest warming up behind Team Metrics: one-time, user-initiated, watched. Six lanes at 250-350ms is ~12 requests a second - a third of the unpaced burst the background lane exists to avoid, and it turns a two-season first load from ~75s of visible refining into ~30s. Background harvests keep the slow lane; the race's roster harvests joined this lane under, for the same watched-spinner reason.
let FOREGROUND_PACING = { paceMs: 250, jitterMs: 100 };
export function setFanOutPacing(pacing, foreground) {
    FAN_OUT_PACING = pacing || { paceMs: 0, jitterMs: 0 };
    FOREGROUND_PACING = foreground || pacing || { paceMs: 0, jitterMs: 0 };
}

// Shared fetch/throw/parse for an ESPN fantasy API call - every endpoint here sends cookies via credentials:'include' and, when filtering the response server-side, an X-Fantasy-Filter header. A non-ok response always means something ESPN-specific went wrong (bad league id, private league, expired auth), worth surfacing as a real Error rather than continuing with a broken response body. VALIDATED against a real logged-out session. ESPN refuses an unauthenticated player-pool request with 405, not 401. That call is the only one carrying an X-Fantasy-Filter header, and the filter is what it objects to. A league read with restrictionType NONE meanwhile succeeds outright with no cookies at all. So the three statuses below mean one thing between them, "you are not logged in", and callers phrase it rather than printing a number at someone who cannot act on it.
const AUTH_STATUSES = new Set([401, 403, 405]);

// Which call this was, read off the URL rather than threaded through every caller. Every request in this file is identifiable from its own view or path, so the tally stays a one-line change at the single call site instead of a parameter on a dozen functions. Ordered most specific first: a weekly-stats request IS a kona_player_info request with a scoring-period filter, so plain "pool" has to be the fallback of the two, not the match.
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

// WHICH SEASON A URL IS ASKING ABOUT, read off the path rather than off the form, because the form can have moved on while a request is in flight. leagueHistory carries no season at all - it is a list of years, and a list of finished years is the definition of not-live.
function seasonOfUrl(url) {
    const m = String(url).match(/\/seasons\/(\d{4})/);
    return m ? Number(m[1]) : null;
}

// LIVE vs HISTORICAL. The distinction earns its keep because the fix for staleness - busting the CDN - is also a courtesy withdrawn from ESPN's servers, and a finished season has nothing to be stale about. So the bust goes exactly where the data can still move today. LIVE, and therefore busted and never cached: league - the current season's payload, which is the scoreboard the owner watched go stale. The kind is broader than its name: requestKindOf answers 'league' for anything under /segments/0/leagues/ that is not a pool or a roster read, so the current season's TRANSACTION LOG (mTransactions2) and its draft (mDraftDetail) ride in on it. That is the right answer for the transaction log, which changes every day a move is made - a stale roster is the same lie the scoreboard told, at lower volume - and a harmless one for the draft, which is a single request that only exists once per season anyway. scoreboard - the odds scoreboard, which is live by definition. rosters - the current season's daily roster snapshots (the Roto Race harvest). pool - the current season's player pool, which carries every season stat line the app shows, GS included. weekly - the current season's per-player weekly history behind the trend charts. schedule - the pro-team fixture list the Schedule tab reads a finished game from. The last three were on the other side of this list until the addendum RULED AGAINST the deferral written here. The owner reported a completed start's GS never ticking up and the Schedule tab never noticing a finished game, and both read current-season sources that were being served from an aged copy. A leaderboard a few hours behind turned out not to be a smaller kind of wrong - it is the same lie about the same day. HISTORICAL, and left on the cache exactly as they are: history - the leagueHistory year list. Finished seasons only, by construction. any past-season url of any kind - a past payload, a past pool, a past draft, a past transaction log. Same shapes, older year in the path, nothing left to change, and these are the deep reads that would actually cost ESPN something. A season is current when it is this calendar year or later. Hockey's 2025-26 season is seasonId 2026, so the comparison has to be >= rather than ==, and a season that has not started yet is still not something to serve from a five-minute-old cache.
const LIVE_KINDS = new Set(['league', 'scoreboard', 'rosters', 'pool', 'weekly', 'schedule']);

// REALTIME, the carve-out above LIVE. Empty on purpose: it is reserved for surfaces where five minutes is an eternity - the draft assistant is the named tenant - and a realtime request keeps the bust-and-no-store treatment every live kind wore before. The class exists NOW so the draft work opts a kind in with one line instead of re-plumbing this file, and so the next reader knows the bust machinery below is dormant rather than dead.
const REALTIME_KINDS = new Set([]);

// THE FRESHNESS LADDER. Three classes, three cache postures: realtime bust + no-store nothing between the reader and ESPN, ever. Reserved (empty). live no-cache, plain URL the browser revalidates every time (If-None-Match rides the ETag it stored), and CloudFront may answer from the edge within its declared max-age=300. Worst case: five minutes. historical browser default finished seasons cannot change; the CDN is welcome to them. The five-minute budget is the OWNER'S RULING, made knowing the trade: busted every live request because the scoreboard froze, then proved the freeze was a FIELD problem (cumulativeScoreLive) the bust never touched, and the bust's real effect was making every live request an origin miss - the exact traffic shape that reads as scraping, which this entry exists to retire. A conditional request is the posture ESPN's CDN invites: a 304 costs the origin nothing and tells the truth within 300 seconds.
function freshnessClassOf(url, filter) {
    const kind = requestKindOf(url, filter);
    if (String(url).includes('/leagueHistory/')) return 'historical';
    const season = seasonOfUrl(url);
    // The odds scoreboard carries no fantasy season in its path; it is live whatever it says.
    const currentSeason = season === null ? kind === 'scoreboard' : season >= new Date().getFullYear();
    if (!currentSeason) return 'historical';
    if (REALTIME_KINDS.has(kind)) return 'realtime';
    if (LIVE_KINDS.has(kind)) return 'live';
    return 'historical';
}

// The cache-busting parameter, now the REALTIME class's tool only. `_` is the conventional name for exactly this and is what every caller of a CDN-fronted API has used for twenty years. VALIDATED against the live host when shipped it (the public proTeamSchedules endpoint on lm-api-reads, the same origin the league payload comes from): the same URL fetched three times answered `X-Cache: Hit from cloudfront` with the Age climbing 19, 21, 23 seconds, while the same URL carrying `_` answered `Miss from cloudfront` all three times with no Age at all. So the parameter is accepted, the body is unchanged (identical ETag), and it reaches the EDGE rather than only the browser.
function withCacheBust(url) {
    return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
}

// A throttle is not an auth failure and not a retryable quirk - it is ESPN saying slow down, and the one unforgivable answer is to speed up. Before, 429 was in nobody's set: it fell into the defensive retry below and every throttled request was IMMEDIATELY re-sent, doubling the rate at exactly the moment the server asked for less. Now a 429 - or any 4xx carrying a Retry-After header, because a CDN that throttles with 403 must not read as "logged out" - throws with `throttled` and a bounded `retryAfterMs`, and the paced queues (runWithConcurrencyLimit) are the only place that waits it out. A foreground action (Fetch Data) surfaces its normal error state instead: a button that silently sleeps for a minute looks dead.
function throttleOf(response) {
    const header = Number(response.headers.get('Retry-After'));
    const throttled = response.status === 429 || (Number.isFinite(header) && header > 0);
    if (!throttled) return null;
    const seconds = Number.isFinite(header) && header > 0 ? header : 30;
    return Math.min(Math.max(seconds, 1), 300) * 1000;
}

// SINGLE-FLIGHT at the one choke point every ESPN call already passes through. Two callers asking for the same URL+filter while the first is still in the air share one wire request. The first caller gets the parsed body; every joiner gets a structuredClone, because callers mutate what they receive (processCoreData annotates the league payload) and a shared object would be the kind of bug that only fires when the race does. The clone is paid only when a race actually happened. Entries clear on settle either way, so a failure never poisons its key.
const inFlightRequests = new Map();

async function fetchEspnJson(url, filter) {
    const flightKey = `${url}|${filter ? JSON.stringify(filter) : ''}`;
    const inFlight = inFlightRequests.get(flightKey);
    if (inFlight) return inFlight.then(data => structuredClone(data));

    const flight = fetchEspnJsonOverWire(url, filter);
    inFlightRequests.set(flightKey, flight);
    try {
        return await flight;
    } finally {
        inFlightRequests.delete(flightKey);
    }
}

async function fetchEspnJsonOverWire(url, filter) {
    const headers = filter ? { 'X-Fantasy-Filter': JSON.stringify(filter) } : {};
    // Counted BEFORE the await, so a request that fails still counts - it was still made, and the question the panel answers is what this page asked for, not what came back. Counted on the UN-busted url so the panel keeps showing the request the app meant to make. A single-flight joiner is deliberately NOT counted: it put nothing on the wire.
    countApiRequest(url, requestKindOf(url, filter));

    const klass = freshnessClassOf(url, filter);
    const init = klass === 'realtime'
        ? { credentials: 'include', headers, cache: 'no-store' }
        : klass === 'live'
            ? { credentials: 'include', headers, cache: 'no-cache' }
            : { credentials: 'include', headers };

    let response = await fetch(klass === 'realtime' ? withCacheBust(url) : url, init);

    // DEFENSIVE, and deliberately narrow: realtime only, because only realtime carries the bust parameter that could ever be the thing refused. Never for a throttle - retrying a 429 immediately is the doubling bug this entry removed - and never for auth, which would just fail again more slowly.
    if (klass === 'realtime' && !response.ok && response.status >= 400 && response.status < 500
        && !AUTH_STATUSES.has(response.status) && response.status !== 429) {
        response = await fetch(url, init);
    }

    if (!response.ok) {
        // The message keeps the status for the diagnostic panel and any log; authRequired is what the UI branches on, so no surface has to know which code ESPN chose this time. A Retry-After on an auth-shaped status means throttle, not logout - see throttleOf.
        const retryAfterMs = throttleOf(response);
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        err.throttled = retryAfterMs !== null;
        err.retryAfterMs = retryAfterMs || 0;
        err.authRequired = AUTH_STATUSES.has(response.status) && !err.throttled;
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
        // Raw, before the picks are unwrapped below: the panel exists for the questions not asked yet, and the draft's own settings and keeper fields live outside the picks array.
        setDebugContext('draft-detail', data);
        return (data && data.draftDetail && data.draftDetail.picks) || [];
    } catch (e) {
        // A throttle escapes the swallow so the queue's gate can slow down and retry; a swallowed throttle would read as "this season has no draft", which is silent data loss.
        if (e && e.throttled) throw e;
        return [];
    }
}

// The most recent PAST season's payload, for the pre-draft face's last-season card. One request, through the same cache the League History tab fills, so a reader who has already opened that tab pays nothing and one who has not pays once. Returns null rather than throwing for a first-season league - there is no past year to ask for - and null for a season that could not be read. The card is absent in both cases, which is the spec's "never faked": a league with no history shows no history rather than an empty card or an error where a summary should be.
export async function loadMostRecentPastSeason() {
    const { sport, leagueId } = getLeagueParams();
    const current = Number(AppState.apiData?.seasonId);
    if (!sport || !leagueId || !Number.isFinite(current)) return null;
    const years = leagueSeasonYears(AppState.leagueHistoryYears, current, new Date().getFullYear());
    const past = [...new Set(years)].filter(y => Number(y) < current).sort((a, b) => b - a);
    if (!past.length) return null;
    try {
        const payloads = await loadHistorySeasons(sport, leagueId, [past[0]]);
        return (payloads && payloads[past[0]]) || null;
    } catch {
        return null;
    }
}

// Fills the panel's draft-detail kind for the LOADED league, on demand. Download All calls this before it collects, which is what makes a draft-shaped capture a normal download rather than a special ask - the draft detail is fetched by nothing until a surface wants it, so on a league whose draft nobody has opened the kind would otherwise always be empty. One request, only when the kind is empty, and only for a league that is actually loaded. It is the ensurePlayerDetailDiagnostic pattern: the panel shows its loading line while this is in flight, and fetchDraftDetail's own success path writes the capture.
export async function ensureDraftDetailCapture() {
    if (hasDebugContext('draft-detail') || !AppState.apiData) return;
    const { sport, leagueId, year } = getLeagueParams();
    if (!sport || !leagueId || !year) return;
    setDebugLoading('draft-detail', true);
    try {
        await fetchDraftDetail(sport, leagueId, year);
    } finally {
        // fetchDraftDetail's success path clears this by writing the context; the finally covers the failure path, so a league whose draft view 404s does not strand a loading line.
        setDebugLoading('draft-detail', false);
    }
}

// One scoring period's transaction slice. mTransactions2 silently scopes to the CURRENT period unless an explicit scoringPeriodId is passed (M0 probe C), which is why the plain call read empty for a completed season. Batching many periods through X-Fantasy-Filter returned 0 rows (M0), so the harvest is genuinely one request per period.
async function fetchTransactionPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTransactions2&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        // Whichever period landed last, exactly as the roster kind works. A harvest is ~196 requests and is NEVER started for a download - this only holds something when the app already ran one for its own reasons.
        setDebugContext('transactions', data);
        return (data && data.transactions) || [];
    } catch (e) {
        // Throttles escape so the queue gate handles them - an empty slice for a throttled period would attribute players wrongly and never say so. A refusal escapes for the same reason one step up: swallowed, it reads as "this period had no moves" and the breaker above can never see the wall it exists to stop at.
        if (isRefusal(e)) throw e;
        return [];
    }
}

// Harvest the whole season's transaction log, one request per scoring period from first to final, merged into a single array. Concurrency-capped like the weekly fetch so a ~196-request hockey season looks like normal browsing traffic, not a burst. This is the expensive, one-time cost of transaction-accurate rosters; callers cache the result for the session (see players.js), and it's the natural artifact a future archive would keep so it never re-fetches. De-duplicated by transaction id because ESPN can echo a multi-period transaction into more than one period slice.
export async function harvestTransactions(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);

    // The foreground lane. The only caller is the Roto Race, which draws nothing until this lands and is on screen while it does - the watched, user-initiated shape the lane was ruled for. There is no background trigger for either roster harvest: the prefetch chain never reaches them, so the slow lane here was a wait nobody was being spared.
    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchTransactionPeriod(sport, leagueId, year, period), FOREGROUND_PACING,
        { stopAfter: REFUSALS_BEFORE_STOP });

    const byId = new Map();
    slices.flat().forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
    return Array.from(byId.values());
}

// The pro sports schedule, which is what turns a probable-start game id into a day. A SEASON endpoint, not a league one. It carries no league id, needs no cookies, and is the same host the manifest already lists, so it adds no permission and no privacy question. One fetch per sport and season, cached in session storage. The response is ~850KB for baseball and a season's schedule does not move, so re-fetching it on every My Team render would be pure waste. Failure is silent by design. The tab's projected-start line does not render, and nothing else on the page depends on it. The other half of invalidating the schedule: myteam.js resetting its own built index was never enough, because this module's AppState copy and the storage.session key kept serving the old body - so "the schedule refetches on the next render" was a comment, not a behaviour, and the Schedule tab could run a whole browser session on one fetch. Dropping both here makes the next ensureProSchedule genuinely ask the network (conditionally - the live class rides ETags now, so an unchanged season answers 304-cheap). THE ONE PLACE THE KEY IS SPELLED. Reader and writer built it separately before, which is how a store belonging to one sport could be read by another: the abbreviations come from this response and nothing else, MLB id 17 is CIN while NFL id 17 is NE, so a football schedule left in memory printed NE over a Cincinnati player and then asked the crest host for mlb/500/NE.png, which 404s. Same function for both sides, so they cannot drift.
function proScheduleKey(sport, year) {
    return `proTeamSchedules:${sport}:${year}`;
}

// PURE, so the wrong-sport case is a test rather than a staging exercise: the body only when the stored key is the one this league would have written, and null otherwise. A payload from another sport or year reads as ABSENT - no club, no crest - never as a plausible wrong club.
export function proScheduleFor(store, sport, year) {
    return store && store.key === proScheduleKey(sport, year) ? store.data : null;
}

// The body for the league on screen, or null.
export function currentProSchedule() {
    const { sport, year } = getLeagueParams();
    return proScheduleFor(AppState.proTeamSchedules, sport, year);
}

// WHETHER THIS LEAGUE'S SCHEDULE HAS BEEN ASKED FOR, which is NOT the same question as whether one is in hand. fetchProTeamSchedules stores `{ key, data: null }` when the fetch fails, so a truthy wrapper with an empty body means "asked and got nothing" - and the leaderboard's lens reasons read exactly that to tell a FAILED schedule from one nobody has requested yet. Collapsing the two into a single data-or-null accessor would turn every failed fetch into a permanent "loading".
export function proScheduleAttemptedFor(store, sport, year) {
    return !!store && store.key === proScheduleKey(sport, year);
}

export function proScheduleAttempted() {
    const { sport, year } = getLeagueParams();
    return proScheduleAttemptedFor(AppState.proTeamSchedules, sport, year);
}

// THE PRESEASON SNAPSHOT'S STORAGE HALF. The DECISIONS - what to keep, when, and what to drop - are pure and live in preseason-snapshot.js; this is only the reading and writing, kept here because api.js already owns browser.storage and because storage is the least testable thing in an extension. The contract is tests/fixtures/preseason-snapshot.md. storage.LOCAL rather than session: the whole point is to outlive the session, and the season.
export async function readPreseasonSnapshot(key) {
    try {
        const got = await browser.storage.local.get(key);
        return (got && got[key]) || null;
    } catch { return null; }   // storage unavailable is "no snapshot", which every reader handles
}

// Every preseason key currently stored, so the retention pass can see what it is pruning. Nothing else is read - the rest of storage.local is not this feature's business.
export async function preseasonSnapshotKeys() {
    try {
        const all = await browser.storage.local.get(null);
        return Object.keys(all || {}).filter(k => k.startsWith('preseason:'));
    } catch { return []; }
}

// WRITE THEN PRUNE, in that order and deliberately. If the write fails there is nothing to make room for, and pruning first would have deleted a good old snapshot to store nothing.
export async function writePreseasonSnapshot(key, value, stale) {
    try {
        await browser.storage.local.set({ [key]: value });
    } catch {
        return false;   // over quota or storage disabled - the feature is absent, not broken
    }
    if (stale && stale.length) {
        try { await browser.storage.local.remove(stale); } catch { /* the new one is stored; old ones can wait */ }
    }
    return true;
}

export async function invalidateStoredProSchedule() {
    const { sport, year } = getLeagueParams();
    const key = proScheduleKey(sport, year);
    if (AppState.proTeamSchedules && AppState.proTeamSchedules.key === key) AppState.proTeamSchedules = null;
    try { await browser.storage.session.remove(key); } catch { /* nothing stored, nothing to drop */ }
}

export async function fetchProTeamSchedules() {
    const { sport, year } = getLeagueParams();
    const key = proScheduleKey(sport, year);
    // THE PANEL GETS THE BODY ON EVERY PATH. setDebugContext used to sit on the network branch alone, so a session that answered from memory or from session storage - which is most of them, this being cached per league per session - left the capture's pro-schedule kind EMPTY. A Download All then produced a set with no schedule in it, and the next lane to stage that capture found the clubs missing and had to go looking for a bug in the reader. The kind describes what the app HOLDS, not which code path fetched it.
    if (AppState.proTeamSchedules && AppState.proTeamSchedules.key === key) {
        setDebugContext('pro-schedule', AppState.proTeamSchedules.data);
        return AppState.proTeamSchedules.data;
    }
    try {
        const cached = await browser.storage.session.get(key);
        if (cached && cached[key]) {
            AppState.proTeamSchedules = { key, data: cached[key] };
            setDebugContext('pro-schedule', cached[key]);
            return cached[key];
        }
    } catch { /* session storage unavailable, fall through to the network */ }
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}?view=proTeamSchedules_wl`;
        const data = await fetchEspnJson(url);
        AppState.proTeamSchedules = { key, data };
        setDebugContext('pro-schedule', data);
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
    // A TABLE, NOT A TERNARY. This read "hockey if fhl, otherwise baseball", so a third sport would have asked ESPN for MLB scores and quietly drawn baseball odds onto its cards. A sport with no scoreboard path here has no odds, which is what most cards show anyway.
    const path = { fhl: 'hockey/nhl', flb: 'baseball/mlb' }[sport];
    if (!path) return null;
    const key = `scoreboard:${sport}:${year}:${new Date().toISOString().slice(0, 13)}`;
    if (AppState.scoreboardOdds && AppState.scoreboardOdds.key === key) return AppState.scoreboardOdds.data;
    try {
        const data = await fetchEspnJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
        AppState.scoreboardOdds = { key, data };
        setDebugContext('odds', data);
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

// myteam.js's own local copy (the field this reads is on apiData.status, not a request) - duplicated rather than imported for the reason findOwnedTeamId moved out of myteam.js entirely: myteam.js already imports from api.js, so the reverse import would be a real cycle. Exported now too: players.js needs the SAME fact to build the `rest` window ([todayPeriod.. finalScoringPeriod]), and players.js already imports from api.js one-way with no cycle risk - myteam.js's duplication above is a different, older case and stays as it was.
export function finalScoringPeriodOf(apiData) {
    const st = (apiData || {}).status || {};
    return st.finalScoringPeriod || st.latestScoringPeriod || null;
}

// Fills the panel's roster kind for the LOADED league, on demand - the ensureDraftDetailCapture pattern, for the same reason. My Team's PRIMARY roster path (rostersFromPayload, myteam.js) reads straight off the league payload with no separate request, so nothing ever fetches a stand-alone mRoster response unless a season has already finished; a Download All run against a league nobody had opened My Team on - or a live season whose payload happened to carry no current-period roster for any team - produced a zip with team.json but no roster.json, because the one function that calls setDebugContext('roster',...) is fetchRosterPeriod, and nothing had asked it to run. Only when the kind is still empty (myteam.js's own capture, added alongside this fix, may already have filled it from the embedded path) and only for a league that is actually loaded.
export async function ensureRosterCapture() {
    if (hasDebugContext('roster') || !AppState.apiData) return;
    const period = finalScoringPeriodOf(AppState.apiData);
    if (!period) return;
    setDebugLoading('roster', true);
    try {
        await fetchRosterForPeriod(period);
    } finally {
        // fetchRosterPeriod's success path clears this by writing the context; the finally covers the failure path, so a league whose mRoster view 404s does not strand a loading line.
        setDebugLoading('roster', false);
    }
}

// One scoring period's roster SNAPSHOT: every team's full roster with the lineupSlotId each player sat in on that exact day. mRoster with an explicit scoringPeriodId returns the historical lineup for a completed season (owner probe: periods 49 vs 50 differ by exactly the lineup edits applied on 50). Distilled to the shape the timeline consumes - [{ id, entries: [{ p, slot }] }] - so the pure module never sees ESPN's full playerPoolEntry payload. Defensive per golden rule 8: any missing field just drops that entry rather than throwing. The raw field names (teams[].id, roster.entries[].playerId,.lineupSlotId) are ESPN's standard mRoster shape; best-effort like the draft/transaction fetches, and a mismatch yields empty snapshots and the fallback ladder.
async function fetchRosterPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mRoster&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        // Captured RAW, before the distillation below throws away every field the timeline does not need. The distilled shape is the answer to one question; the schema panel exists for the questions not asked yet, and mRoster is the view the owner has no capture of.
        setDebugContext('roster', data);
        return (data && data.teams || []).map(t => ({
            id: t.id,
            entries: ((t.roster && t.roster.entries) || [])
                .map(e => ({ p: e.playerId, slot: e.lineupSlotId }))
                .filter(e => e.p != null && e.slot != null)
        }));
    } catch (e) {
        // Throttles escape to the queue gate; a swallowed one would read as a day with no lineups and quietly demote the race's started-accuracy. A refusal escapes for the breaker's sake, same as the transaction worker's.
        if (isRefusal(e)) throw e;
        return [];
    }
}

// Harvest the whole season's daily roster snapshots, one request per scoring period, into { days: { period: [{ id, entries }] } }. Same shape and cost as harvestTransactions - one request per period, concurrency-capped so a ~196-request season reads as normal browsing - and cached for the session by the caller (players.js). This is what upgrades the race from rostered-accurate to STARTED-accurate. The snapshot says not just who owned a player but whether they were in a starting slot that day, which is exactly the distinction ESPN's own standings count.
export async function harvestRosters(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);

    // Foreground lane, same reasoning as harvestTransactions.
    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchRosterPeriod(sport, leagueId, year, period), FOREGROUND_PACING,
        { stopAfter: REFUSALS_BEFORE_STOP });

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

// One past season's league payload, for League History. The SAME views the current season fetches, because history reads the same fields: teams for franchise identity and final ranks, schedule for the bracket champion and the head-to-head grid, settings for the season's scoring format and its category set. leagueHistory itself is only asked WHICH years exist (fetchLeagueHistorySeasons above). Whether its array entries also carry full payloads is unverified against a real league, so this fetches each season directly rather than trusting a shape nobody has measured - see docs/DATA-SOURCES.md section 9. If that array does turn out to carry everything, this becomes the fallback rather than the path.
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

// One past season's PLAYER POOL, for the career table. Deliberately the most expensive thing League History can ask for, and so the only thing it never asks for on its own: the tab's champions, standings, head-to-head and category tables are built from the league payloads above and must never wait on this. It runs when the career table is opened, and not before. The filter is narrow for a measured reason. A capture taken with the daily splits left in is 52 MB per season; the same league filtered to season totals is 4.1 MB. Both axes are honoured - the filtered capture came back with no split-5 blocks at all - so this asks for source 0 (real, not projected, which for a finished season is the only kind that means anything) split 0 (the season total). See docs/DATA-SOURCES.md section 9.
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
    const data = await fetchEspnJson(url, filter);
    setDebugContext('history-pool', data);
    return data;
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

// EVERY FRANCHISE THAT HELD A PLAYER, per season. The careers table's franchise column used to read the pool's onTeamId, which is the roster at the moment of the fetch - so a player who was dropped before it attributed to nobody, and the owner's drafted-and-held case showed only the season they happened to still be rostered in. THE COST, measured across the fixture set: the transaction log is one request per scoring period (ESPN scopes mTransactions2 to the current period unless asked otherwise, and batching through X-Fantasy-Filter returns zero rows - both established in the probes). That is 187 to 196 requests per season, so a five-season league is close to a thousand. Three things keep it honest: 1. It is LAZY, behind the careers pane, which is already the one part of this tab that pays for anything. Nobody who never opens careers fetches a single transaction. 2. The live season reuses the log the Roto Race already harvested when it is in hand, which is the ~192 requests most often already spent. 3. It is cached per season for the session, like the pools beside it. A season whose log cannot be read falls back to onTeamId rather than blanking the column, which is golden rule 8: the old answer was incomplete, not wrong, so an unreadable year degrades to it.
const ownershipCache = new Map();

// THE PICKS, CACHED APART FROM THE OWNERSHIP MAP. A deferred season is deliberately never written to ownershipCache - a draft-only map must not read back as that season's final answer - and the cost of that correct decision was a SECOND draft request every time a chip made the season pending again. Measured on the six-season fixture: one chip cost 196 requests rather than 195, four cost 784 rather than 780, and the season's bucket read draft:2. Two caches rather than one because they answer different questions: this one is "what did this season's draft say", which is finished history the moment the draft ends, and ownershipCache is "is this season's attribution final", which a deferred season's is not. Splitting them lets the second stay strict while the first stops paying twice. ONLY A NON-EMPTY RESULT IS CACHED. fetchDraftDetail returns [] for a season with no draft AND for a season whose request failed, and it cannot tell the caller which - so caching [] would freeze one bad minute into "this league never drafted" for the rest of the session, which is the poisoning ensurePlayerDataLoaded already guards against. A genuinely draftless season therefore re-asks once per chip, exactly what it costs today, and no season is ever worse off.
const historyDraftPicksCache = new Map();

// ONE SHARED LIMITER ACROSS SEASONS. The old shape walked seasons in a for..of with an await, so each season's 190 requests drained to zero before the next one's first request went out - and the gap at the end of every season is dead time no cap requires. WHAT THIS DOES NOT DO, said plainly because the entry hoped for it: three seasons cannot approach the wall-clock of one. The cap is 6 TOTAL and the request count is unchanged, so the floor is still (seasons x periods) / 6 waves. What sharing the limiter buys is the drain gap between seasons and nothing more. The change that makes the pane usable is the draft-first render below, which puts a full table on screen after one request per season instead of after all of them. Tasks are queued season by season rather than round-robin, deliberately: the limiter then finishes the seasons IN ORDER, so per-season progressive fill still lands one season at a time instead of every season completing together at the very end.
export async function loadHistoryOwnership(sport, leagueId, years, payloadsByYear, options = {}) {
    const { onDrafts, onSeason, onProgress, onRefused, liveSeason, liveSeasonPending, fullLogYears } = options;
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
        if (onDrafts) onDrafts(owners, [], []);
        return owners;
    }

    // THE ON-DEMAND SPLIT. Drafts fetch for every pending season - one request each, and what makes the table render at all - but the ~194-per-season transaction WALK runs only for the years the caller named in fullLogYears (all of them when it is absent, which is the pre- behaviour). A deferred season keeps draft-only attribution and is NEVER written to the ownership cache, so a later call naming it starts clean instead of reading a draft-only map back as final. Measured cost this splits: 1,179 requests on the six-season fixture's one click, ~194 of them per season actually walked.
    const walkSet = fullLogYears ? new Set(fullLogYears) : null;
    let walkYears = walkSet ? pending.filter(y => walkSet.has(y)) : [...pending];

    // JOIN THE HARVEST ALREADY RUNNING. liveSeason above is the log in hand; this is the log ON ITS WAY. The Roto Race starts a ~196-request walk of the live season on every roto open, and a reader who reached this pane before it finished used to start a SECOND walk of the same periods - measured at 392 requests against the 196 the same click cost a slower reader. The season is dropped from the walk list and its slot waits on the race's own promise instead. It stays in `pending`, so PHASE 1 still fetches its draft and the pane still paints its draft-only tier at the same moment it does today; only the walk is skipped. Refinement arrives through the same onSeason callback a self-walked season uses, so the view needs no new state and cannot tell the two apart.
    const joinYear = liveSeasonPending && walkYears.includes(liveSeasonPending.year)
        ? liveSeasonPending.year : null;
    if (joinYear !== null) walkYears = walkYears.filter(y => y !== joinYear);
    const deferredYears = pending.filter(y => !walkYears.includes(y) && y !== joinYear);

    // PHASE 1: the drafts, one request per season, all of them through the shared limiter. This is the cheap half and it attributes every player who was drafted and never moved - which in a quiet league is most of them.
    const picksByYear = {};
    const draftKey = (year) => `${sport}:${leagueId}:${year}`;
    pending.forEach(year => {
        const cached = historyDraftPicksCache.get(draftKey(year));
        if (cached) picksByYear[year] = cached;
    });
    const needDraft = pending.filter(year => !picksByYear[year]);
    const draftResults = await runWithConcurrencyLimit(needDraft, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (year) => fetchDraftDetail(sport, leagueId, year));
    needDraft.forEach((year, i) => {
        const picks = draftResults[i] || [];
        picksByYear[year] = picks;
        if (picks.length) historyDraftPicksCache.set(draftKey(year), picks);
    });

    // THE DRAFT MAPS GO STRAIGHT INTO `owners`. built them in a separate object and handed that to onDrafts, which left `owners` holding only cached and finished seasons - so the first season's log to land published a map with every OTHER pending season MISSING, and buildCareers fell those columns back to the pool's onTeamId. That is the season-end snapshot item 5 measured wrong for most of a pool, so the table regressed to the exact bug fixed, mid-refinement, while the note above it still said the franchises came from the draft. One map, seeded here and overwritten season by season in finish(), makes the intermediate states impossible to get wrong rather than merely correct today. It needs two-plus uncached seasons to show at all, which is how it survived the single-season pass.
    pending.forEach(year => {
        const picks = picksByYear[year];
        if (picks.length) owners[year] = ownerTeamIdsByPlayer(buildRosterTimeline({ picks }));
    });
    // The table can render now, on draft-based attribution, while the log is still coming. The walking list rides along so the caller can say how many seasons are still refining without guessing - a cached season never appears in it - and the deferred list beside it, so the view can OFFER those seasons instead of waiting on logs that were never requested.
    const refiningYears = joinYear === null ? [...walkYears] : [...walkYears, joinYear];
    if (onDrafts) onDrafts(owners, refiningYears, [...deferredYears]);

    // PHASE 2: every (season, period) pair as ONE task list through the SAME limiter. No period bounds means nothing to walk. That season keeps its draft-only attribution, which is the golden rule 8 answer rather than a blank column.
    const periodTasks = (year) => {
        const status = ((payloadsByYear && payloadsByYear[year]) || {}).status || {};
        const first = status.firstScoringPeriod;
        const final = status.finalScoringPeriod;
        if (!Number.isFinite(first) || !Number.isFinite(final)) return [];
        const out = [];
        for (let period = first; period <= final; period++) out.push({ year, period });
        return out;
    };
    const tasks = [];
    walkYears.forEach(year => { tasks.push(...periodTasks(year)); });

    const remaining = new Map();
    const txByYear = {};
    walkYears.forEach(year => { txByYear[year] = []; });
    if (joinYear !== null) txByYear[joinYear] = [];
    tasks.forEach(t => remaining.set(t.year, (remaining.get(t.year) || 0) + 1));

    // `cache: false` publishes the attribution without declaring it final. A season that stopped short has a PARTIAL log, and writing that to ownershipCache would make the chip's retry a no-op - the second call would resolve from the cache and issue nothing, which is exactly the bug the deferred path already avoids by never caching a draft-only season. Found by staging the retry rather than by reading: the chip was there, the click did nothing, and the request count came back identical with and without it.
    const finish = (year, { cache = true } = {}) => {
        const key = `${sport}:${leagueId}:${year}`;
        const picks = picksByYear[year] || [];
        // De-duplicated by id because ESPN can echo a multi-period transaction into more than one period slice - the same rule harvestTransactions applied when it owned this.
        const byId = new Map();
        (txByYear[year] || []).forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
        const transactions = [...byId.values()];
        const map = (picks.length || transactions.length)
            ? ownerTeamIdsByPlayer(buildRosterTimeline({ picks, transactions }))
            : null;
        if (cache) ownershipCache.set(key, map);
        // null only when the season had neither picks nor transactions - and a season with no picks was never seeded above, so the fallback contract is unchanged: nothing to overwrite, and the year stays absent so buildCareers uses onTeamId for it.
        if (map) owners[year] = map;
        if (onSeason) onSeason(year, owners);
    };

    // A season with no periods to walk is done the moment its draft is in. Walked years only: a deferred year is not done, it is not started, and finishing it would cache a draft-only map as that season's final answer.
    walkYears.filter(year => !remaining.has(year)).forEach(finish);

    let done = 0;
    // A refusal is host-wide, not season-specific, so tripping stops the WHOLE task list rather than one season's share of it - the seasons behind the wall would meet the same wall.
    let refused = false;
    const walkAll = runWithConcurrencyLimit(tasks, WEEKLY_MAX_CONCURRENT_CHUNKS, async (task) => {
        const slice = await fetchTransactionPeriod(sport, leagueId, task.year, task.period);
        if (slice && slice.length) txByYear[task.year].push(...slice);
        done += 1;
        if (onProgress) onProgress(done, tasks.length);
        const left = (remaining.get(task.year) || 0) - 1;
        remaining.set(task.year, left);
        if (left === 0) finish(task.year);
    }, FOREGROUND_PACING, { stopAfter: REFUSALS_BEFORE_STOP, onTrip: () => { refused = true; } });

    // The joined season, running BESIDE the walk rather than before it, so the other seasons are not held behind somebody else's harvest. A rejection is not an error here - the race's harvest failing says nothing about whether this pane can read the log - so the season falls back to the walk it would have done anyway, one season's worth of requests and no worse than before the join existed.
    const joinWork = joinYear === null ? Promise.resolve() : liveSeasonPending.promise.then(
        (res) => {
            if (res && res.picks && res.picks.length) picksByYear[joinYear] = res.picks;
            txByYear[joinYear] = (res && res.transactions) || [];
            finish(joinYear);
        },
        async () => {
            const own = periodTasks(joinYear);
            await runWithConcurrencyLimit(own, WEEKLY_MAX_CONCURRENT_CHUNKS, async (task) => {
                const slice = await fetchTransactionPeriod(sport, leagueId, task.year, task.period);
                if (slice && slice.length) txByYear[task.year].push(...slice);
            }, FOREGROUND_PACING, { stopAfter: REFUSALS_BEFORE_STOP, onTrip: () => { refused = true; } });
            finish(joinYear);
        }
    );

    await Promise.all([walkAll, joinWork]);

    // A queue that gave up on throttled periods leaves those seasons' counters short, and a season that never reaches zero would never fire finish - a spinner that spins forever. Finish them here with whatever arrived: partial attribution from a throttled harvest is the same degradation as an unreadable period, and the pane completes late rather than never. A season the walk never finished. Without a trip this is the throttle-gate giving up on a few periods and the season completing late; with one it is a season that stopped short, and the pane is told which so it can say so rather than presenting draft-only columns as final.
    const short = [];
    remaining.forEach((left, year) => { if (left > 0) { short.push(year); finish(year, { cache: !refused }); } });
    if (refused && onRefused) onRefused(short);

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

    const url = leagueUrl(sport, leagueId, year);

    let succeeded = false;
    try {
        const data = await fetchEspnJson(url);

        setDebugContext('team', data);
        AppState.apiData = data;
        AppState.leagueDataError = null;
        // The history year list is immutable within a session - a league's first-ever season does not appear mid-afternoon - so a list already stored for THIS league is reused rather than refetched on every Fetch Data press. Keyed without the year on purpose: the same league's list is the same list whichever season is being fetched.
        const historyKey = `${sport}:${leagueId}`;
        let storedYears = null;
        try {
            const s = await browser.storage.session.get(['leagueHistoryYears', 'leagueHistoryKey']);
            if (s.leagueHistoryKey === historyKey && Array.isArray(s.leagueHistoryYears)) storedYears = s.leagueHistoryYears;
        } catch { /* no session storage - fetch as before */ }
        AppState.leagueHistoryYears = storedYears || await fetchLeagueHistorySeasons(sport, leagueId);
        await browser.storage.session.set({
            apiData: data, leagueHistoryYears: AppState.leagueHistoryYears, leagueHistoryKey: historyKey,
            lastLeagueFetchKey: `${sport}:${leagueId}:${year}`, lastLeagueFetchAt: Date.now()
        });
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
