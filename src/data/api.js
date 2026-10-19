/**
 * ESPN requests, the session cookies that authenticate them, and what the extension keeps in
 * browser storage.
 *
 * Every league request is sent from this browser with the ESPN login already in it. League data is
 * read here and is sent nowhere else.
 *
 * @module api
 */
/**
 * The marks ESPN's fan profile carries for one league. A mark is present only when it was the
 * expected type.
 *
 * @typedef {object} LeagueMarks
 * @property {number} [teamId] The reader's own team in the league.
 * @property {string} [subType] ESPN's sub-type name, which marks a mock draft lobby.
 * @property {boolean} [drafted] Whether the league's draft is complete.
 * @property {boolean} [inSeason] Whether the league is in season.
 */
/**
 * One league the account lookup found.
 *
 * @typedef {object} DiscoveredLeague
 * @property {string} key sport:leagueId.
 * @property {string} leagueId The league id.
 * @property {string} sport The sport code.
 * @property {number} seasonId The newest season the lookup listed.
 * @property {string} label The league's name.
 * @property {number} [teamId] As LeagueMarks.
 * @property {string} [subType] As LeagueMarks.
 * @property {boolean} [drafted] As LeagueMarks.
 * @property {boolean} [inSeason] As LeagueMarks.
 */
/**
 * What loading an archive file came to. Exactly one of the reasons is present when ok is false.
 *
 * @typedef {object} ArchiveLoadResult
 * @property {boolean} ok Whether the archive loaded.
 * @property {boolean} [summaryZip] The file is the spreadsheet summary's zip, not an archive.
 * @property {object[]} [issues] What the archive's validation found.
 * @property {string} [parseError] The file is not JSON.
 */
/**
 * A harvest of daily rosters and how far it got.
 *
 * @typedef {object} RosterHarvest
 * @property {Object<string, Array<{id: number, entries: Array<{p: number, slot: number}>}>>} days
 *   Each scoring period that answered with a lineup, as its teams with their players and slots.
 * @property {number} asked The scoring periods asked for.
 * @property {number} got The scoring periods that answered.
 * @property {?string} error The refusal that stopped the harvest, when one did.
 */
/**
 * What loadHistoryOwnership is told and calls back with.
 *
 * @typedef {object} OwnershipOptions
 * @property {function(object, number[], number[]): void} [onDrafts] Called once the drafts are in, with
 *   the result so far, the seasons still refining and the seasons left out.
 * @property {function(number, object): void} [onSeason] Called as each season's log completes.
 * @property {function(number, number): void} [onProgress] Called with periods done and periods to walk.
 * @property {function(number[]): void} [onRefused] Called with the seasons that stopped short of a refusal.
 * @property {object} [liveSeason] The live season's picks and transactions, when already in hand.
 * @property {{year: number, promise: Promise<object>}} [liveSeasonPending] A fetch of the live season's
 *   log already under way.
 * @property {number[]} [fullLogYears] The seasons whose logs to walk. All of them when absent.
 */
/**
 * The rules the every-league model reads for one league.
 *
 * @typedef {object} LeagueTodayRules
 * @property {number[]} benchSlots The lineup slot ids that are the bench.
 * @property {number[]} nonStartingSlots Every lineup slot id that does not start.
 * @property {?(number|string)} gamesId The stat id that counts games played.
 * @property {?number} gameLengthMs How long a game is taken to run.
 * @property {string[]} categoryIds The league's own scored stat ids.
 * @property {Array<number|string>} rateIds The stat ids that are rates.
 */
import { AppState, NON_STARTING_SLOTS, LINEUP_SLOT_LABELS, AVERAGE_STATS } from './state.js';
import { setDebugContext, hasDebugContext, debugContextFor, hasSeasonDebugContext, setSeasonDebugContext, getRequestTally, setDebugLoading, escapeHtml, countApiRequest, logRequest, leagueSeasonYears, yearOptionsWith, renderActiveLeagueView, findOwnedTeamId } from '../views/utils.js';
import { buildRosterTimeline, ownerTeamIdsByPlayer } from '../engines/roster-timeline.js';
import { processCoreData } from './data.js';
import { buildNicknamesSheet } from '../views/controls.js';
import { validateArchive } from './archive.js';
import { GAMES_PLAYED_IDS } from '../engines/rank-engine.js';
import { activeByLookup, leaguesToday, leaguesTodayAt } from '../engines/league-today.js';

// The host permission the cookie reads and every ESPN fetch depend on.
const ESPN_ORIGINS = { origins: ['*://*.espn.com/*'] };

// Firefox treats host permissions as opt-in for a store or file install, so cookie reads return nothing until access is granted. A browser with no permissions API is treated as granted.
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

/**
 * Reads the two ESPN session cookies and shows the sign-in or permission prompt when they are
 * missing. On the first signed-in run it starts league discovery and announces the restored login.
 *
 * @returns {Promise<void>}
 */
export async function checkAuth() {
    const s2Cookie = await readEspnCookie('espn_s2');
    const swidCookie = await readEspnCookie('SWID');
    const authStatus = document.getElementById('auth-status');
    const grantBtn = document.getElementById('grant-access-btn');
    if (grantBtn) grantBtn.style.display = 'none';

    if (s2Cookie && swidCookie) {
        // Success needs no banner. Only missing cookies are worth showing.
        authStatus.textContent = '';
        authStatus.style.display = 'none';
        // Remember the SWID so the weekly recap can auto-pick "my team" (matches team owners).
        AppState.userSwid = swidCookie.value || '';
        // League discovery is started and not awaited, since the manual fields work whether or not it succeeds. Only the first signed-in run builds the picker.
        if (!authSatisfied) populateLeaguePicker(swidCookie.value).catch(() => {});
        const wasSatisfied = authSatisfied;
        authSatisfied = true;
        // A signed-out session has become a signed-in one, so anything that failed for want of a login can now succeed. The page is told through an event and decides what to reload.
        if (!wasSatisfied) document.dispatchEvent(new CustomEvent('leaguewise:auth-restored'));
        return;
    }

    authSatisfied = false;
    authStatus.style.display = '';
    authStatus.className = 'status-red';

    // No cookies could mean no ESPN login, or that this install was never granted espn.com. The permission is asked for first, and only when it is granted is "log in" the right diagnosis.
    if (!(await hasEspnHostAccess())) {
        authStatus.textContent = '⚠️ Leaguewise needs access to espn.com.';
        if (grantBtn) {
            grantBtn.style.display = '';
            // The request must be the first thing the click does, or Firefox no longer counts it as a user gesture and refuses the prompt. Assigned as onclick so a re-render never stacks handlers.
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

// Installing first and signing in second is the normal first run, so the page watches for the login. One re-check at a time, and none while already signed in.
let authRecheckTimer = null;
function recheckAuthSoon() {
    if (authSatisfied || authRecheckTimer) return;
    authRecheckTimer = setTimeout(() => {
        authRecheckTimer = null;
        checkAuth();
    }, 250);
}

/**
 * Watches for the reader signing in after the page opened, by cookie changes and by the page
 * regaining focus.
 *
 * @returns {void}
 */
export function setupAuthWatchers() {
    // The precise layer. A cookie change on espn.com fires once the host permission is granted, which is when the cookies become visible.
    try {
        browser.cookies?.onChanged?.addListener((change) => {
            const domain = change?.cookie?.domain || '';
            if (isEspnHost(domain)) recheckAuthSoon();
        });
    } catch { /* no listener available, the focus layer below still covers it */ }

    // The layer that needs no permission. Returning to this page is the moment a reader comes back from signing in.
    window.addEventListener('focus', recheckAuthSoon);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') recheckAuthSoon();
    });
}

// ESPN's fan profile lists every fantasy league the signed-in account belongs to. Each entry's game id names its sport.
const FAN_API_GAME_IDS = { 1: 'ffl', 2: 'flb', 3: 'fba', 4: 'fhl' };
// Football is listed so its leagues can be discovered and picked.
const SUPPORTED_SPORTS = new Set(['flb', 'fhl', 'ffl']);

// The full cross-sport league list from the last successful discovery, kept in memory so a #sport change can re-render the picker filtered to the selected sport without re-fetching the fan API.
let discoveredLeagues = [];

/**
 * Reads the marks ESPN's fan profile carries for one league entry.
 *
 * A mark that is not the expected type is left out, never coerced, so an absent mark stays absent.
 *
 * @param {object} pref One preference from the fan profile.
 * @returns {LeagueMarks} The marks found.
 */
export function lookupMarksOf(pref) {
    const meta = (pref && pref.metaData) || {};
    const entry = meta.entry || {};
    const em = entry.entryMetadata || {};
    const marks = {};
    if (Number.isFinite(entry.entryId)) marks.teamId = entry.entryId;
    if (typeof em.leagueSubTypeName === 'string') marks.subType = em.leagueSubTypeName;
    if (typeof em.draftComplete === 'boolean') marks.drafted = em.draftComplete;
    if (typeof meta.inSeason === 'boolean') marks.inSeason = meta.inSeason;
    return marks;
}

// The fan profile request and the removal of duplicates, shared by the first discovery and the background refresh.
async function discoverLeaguesOverWire(swid) {
    const data = await fetchEspnJson(`https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`);

    // Keyed by sport and league id, never by season. The fan profile can list one league once per season, and only its newest season is kept.
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
        // The label carries no season and no sport, since the Year and Sport controls already say both.
        byLeague.set(key, {
            key,
            leagueId,
            sport,
            seasonId: entry.seasonId,
            label: group.groupName || entry.name || `League ${leagueId}`,
            ...lookupMarksOf(pref)
        });
    });
    return Array.from(byLeague.values());
}

/**
 * Fills the My Leagues picker for the signed-in account, from the session cache when there is one
 * and from ESPN's fan profile otherwise.
 *
 * @param {string} swid The account's SWID cookie value.
 * @returns {Promise<void>}
 */
export async function populateLeaguePicker(swid) {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;

    // The cached list paints first so the picker never waits on the network. A background check then redraws it only if the list changed. The cache is keyed by account so a login switch never shows another account's leagues.
    const discoveryKey = `discoveredLeagues:${swid}`;
    try {
        const cached = await browser.storage.session.get(discoveryKey);
        if (Array.isArray(cached[discoveryKey]) && cached[discoveryKey].length) {
            discoveredLeagues = cached[discoveryKey];
            wireLeaguePicker(select, { autoFetch: false });
            renderMyLeaguesOptions();
            revalidateDiscoveredLeagues(swid);
            return;
        }
    } catch { /* no session storage - discover as before */ }

    discoveredLeagues = await discoverLeaguesOverWire(swid);
    if (discoveredLeagues.length === 0) return;
    try { await browser.storage.session.set({ [discoveryKey]: discoveredLeagues }); } catch { /* memory copy still works */ }

    wireLeaguePicker(select, { autoFetch: false });
    renderMyLeaguesOptions();
}

// Two lists are the same when every league carries the same season and label. Order is not compared, since the fan profile's order is not a promise.
function sameLeagueList(a, b) {
    if (a.length !== b.length) return false;
    // The league sub-type is compared too, so a list cached before it was read counts as changed.
    const norm = (list) => list.map(l => `${l.key}:${l.seasonId}:${l.label}:${l.subType ?? ''}`).sort().join('|');
    return norm(a) === norm(b);
}

// Asks for the league list again in the background and redraws only on a difference. A failed or empty answer changes nothing, since nobody asked for a refresh.
async function revalidateDiscoveredLeagues(swid) {
    try {
        const found = await discoverLeaguesOverWire(swid);
        if (!found.length) return;
        const changed = !sameLeagueList(discoveredLeagues, found);
        discoveredLeagues = found;
        const discoveryKey = `discoveredLeagues:${swid}`;
        try { await browser.storage.session.set({ [discoveryKey]: found }); } catch { /* memory copy still works */ }
        if (changed) renderMyLeaguesOptions();
    } catch {
        // Nothing. See the note above.
    }
}

// autoFetch is explicit. Choosing a saved league fills the fields, and the fetch waits for the Fetch button unless a caller asks otherwise.
function wireLeaguePicker(select, { autoFetch = true } = {}) {
    select.onchange = () => {
        // The "Choose..." placeholder has an empty value and matches no league.
        if (select.value === '') return;
        // Values are stable sport:leagueId keys, not list indices, so this lookup survives the sport-filtered re-renders that rebuild the option set.
        const league = discoveredLeagues.find(l => l.key === select.value);
        if (!league) return;
        document.getElementById('sport').value = league.sport;
        document.getElementById('league-id').value = league.leagueId;
        const yearSelect = document.getElementById('year');
        const seasonStr = league.seasonId?.toString();
        // A season the dropdown does not list is added and never skipped. A league's next season is not in the static list, and the year comes from ESPN's own listing.
        if (seasonStr && !Array.from(yearSelect.options).some(o => o.value === seasonStr)) {
            const years = yearOptionsWith(Array.from(yearSelect.options).map(o => o.value), seasonStr);
            yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
        }
        if (seasonStr) yearSelect.value = seasonStr;
        if (autoFetch) fetchEspnData();
    };
}

/**
 * The discovered league for a picker key.
 *
 * @param {string} key A key of the form sport:leagueId.
 * @returns {?DiscoveredLeague} The league record, or null.
 */
export function discoveredLeagueByKey(key) {
    return discoveredLeagues.find(l => l.key === key) || null;
}

/**
 * The leagues the picker offers for one sport: every discovered league of that sport except ESPN's
 * mock draft lobbies.
 *
 * @param {DiscoveredLeague[]} leagues The discovered league records.
 * @param {string} sport The sport code.
 * @returns {DiscoveredLeague[]} The leagues to list.
 */
export function pickerLeaguesFor(leagues, sport) {
    return (leagues || []).filter(l => l && l.sport === sport && activeByLookup(l).reason !== 'mock');
}

/**
 * Redraws the My Leagues picker for the sport now selected, and hides it when that sport has no
 * discovered league.
 *
 * @returns {void}
 */
export function renderMyLeaguesOptions() {
    const wrap = document.getElementById('my-leagues-wrap');
    const select = document.getElementById('my-leagues');
    if (!wrap || !select) return;
    const currentSport = document.getElementById('sport').value;
    const forSport = pickerLeaguesFor(discoveredLeagues, currentSport);
    if (forSport.length === 0) {
        // Nothing discovered for this sport, so the picker is hidden. Manual league id entry still works.
        select.value = '';
        wrap.style.display = 'none';
        return;
    }
    select.innerHTML = '<option value="">Choose...</option>' +
        forSport.map(l => `<option value="${escapeHtml(l.key)}">${escapeHtml(l.label)}</option>`).join('');
    wrap.style.display = '';
}

/**
 * Restores the saved sport, league and year, and the session's cached league payload when there is
 * one, then refreshes that payload in the background.
 *
 * @returns {Promise<void>}
 */
export async function loadStoredSettings() {
    const stored = await browser.storage.local.get(['sport', 'leagueId', 'year']);
    if (stored.sport) document.getElementById('sport').value = stored.sport;
    if (stored.leagueId) document.getElementById('league-id').value = stored.leagueId;
    // A stored year the static list does not carry is added, never dropped. Setting a select to a value it has no option for leaves it empty.
    if (stored.year) {
        const yearSelect = document.getElementById('year');
        const storedYear = String(stored.year);
        if (!Array.from(yearSelect.options).some(o => o.value === storedYear)) {
            const years = yearOptionsWith(Array.from(yearSelect.options).map(o => o.value), storedYear);
            yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
        }
        yearSelect.value = storedYear;
    }

    const session = await browser.storage.session.get(['apiData', 'leagueHistoryYears']);
    if (session.apiData) {
        AppState.apiData = session.apiData;
        AppState.leagueHistoryYears = session.leagueHistoryYears || [];
        // A restored session never goes through the fetch, so the diagnostic panel's league payload is set here.
        setDebugContext('team', session.apiData);
        processCoreData();
        loadNicknames();
        // The cached view is up. Whether it is still true is checked in the background and not awaited.
        revalidateLeagueData();
    }
}

// A restored session paints from storage that outlives the tab, so one background read refreshes it after the paint. A failed read changes nothing. Within five minutes of the last successful fetch nothing is sent.
const LEAGUE_REVALIDATE_MIN_MS = 300000;

async function revalidateLeagueData() {
    const { sport, leagueId, year } = getLeagueParams();
    if (!leagueId) return;

    try {
        const gate = await browser.storage.session.get(['lastLeagueFetchKey', 'lastLeagueFetchAt']);
        if (gate.lastLeagueFetchKey === `${sport}:${leagueId}:${year}`
            && Date.now() - (gate.lastLeagueFetchAt || 0) < LEAGUE_REVALIDATE_MIN_MS) return;
    } catch { /* no session storage, no gate - revalidate as before */ }

    // What the screen shows is captured before the request. If the reader loads another league while it is in flight, the late answer is dropped.
    const shownSeason = AppState.apiData?.seasonId;
    const shownLeague = AppState.apiData?.id;

    try {
        const data = await fetchEspnJson(leagueUrl(sport, leagueId, year));
        if (AppState.apiData?.seasonId !== shownSeason || AppState.apiData?.id !== shownLeague) return;

        AppState.apiData = data;
        AppState.leagueDataError = null;
        setDebugContext('team', data);
        // The history years are written back with the payload so the session entry stays whole.
        await browser.storage.session.set({
            apiData: data, leagueHistoryYears: AppState.leagueHistoryYears,
            lastLeagueFetchKey: `${sport}:${leagueId}:${year}`, lastLeagueFetchAt: Date.now()
        });
        processCoreData({ revalidate: true });
        loadNicknames();
    } catch {
        // Nothing. See the note above.
    }
}

// The league payload's URL in one place, so the background refresh asks for exactly the views the fetch asks for.
function leagueUrl(sport, leagueId, year) {
    return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam&view=mMatchupScore&view=mSettings&view=mBoxscore`;
}

// Reads the sport, league and year the reader has entered, the three fields every request here builds its URL from.
function getLeagueParams() {
    return {
        sport: document.getElementById('sport').value,
        leagueId: document.getElementById('league-id').value,
        year: document.getElementById('year').value
    };
}

// Runs a worker over every item with a cap on how many are in flight, and an optional pause after each so a long queue is paced as well as capped. A throttled answer pauses every lane and retries. A refusal is the host declining to answer at all, and it is the only failure the breaker counts.
const isRefusal = (e) => !!(e && (e.throttled || e.authRequired));

// Five refusals in a row cannot be a property of five particular requests, so the queue stops asking a host that has already said no.
const REFUSALS_BEFORE_STOP = 5;

// The breaker is optional. Without one the queue behaves as it did before breakers existed.
async function runWithConcurrencyLimit(items, limit, worker, pacing, breaker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let gate = null;
    let pausesLeft = 3;
    let refusals = 0;
    let tripped = false;

    // At the threshold the queue stops handing out work. The lanes finish what they hold, and every item not started takes undefined, which each caller treats as its empty result.
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

// The pacing for a harvest the reader is watching. Six lanes at this pace send about twelve requests a second.
const FOREGROUND_PACING = { paceMs: 250, jitterMs: 100 };

// The shared fetch, error and parse for an ESPN request. ESPN answers an unauthenticated request with any of these three statuses, so callers say "not logged in" and never print the number.
const AUTH_STATUSES = new Set([401, 403, 405]);

/**
 * The host of a URL, lower-cased, or an empty string when the text is not a URL.
 *
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * Whether a host or cookie domain is espn.com itself or one of its subdomains. A substring test
 * would accept any host that merely contains the name, so the match is on the whole label chain.
 *
 * @param {string} host A hostname or a cookie domain, with or without its leading dot.
 * @returns {boolean}
 */
export function isEspnHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\./, '');
    return h === 'espn.com' || h.endsWith('.espn.com');
}

// Which request this was, read off its URL so no caller has to say. Most specific first, since a weekly request is a pool request with a scoring period filter.
function requestKindOf(url, filter) {
    const u = String(url);
    if (hostOf(u) === 'fan.api.espn.com') return 'league list';
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

// Which season a URL asks about, read off its path, since the form can have moved on while a request is in flight.
function seasonOfUrl(url) {
    const m = String(url).match(/\/seasons\/(\d{4})/);
    return m ? Number(m[1]) : null;
}

// The kinds of request whose answer can still change today. A season is current when it is this calendar year or later, and a past season of any kind is left to the cache.
const LIVE_KINDS = new Set(['league', 'scoreboard', 'rosters', 'pool', 'weekly', 'schedule']);

// The class above live, for a surface where five minutes is too long. It is empty until something needs it.
const REALTIME_KINDS = new Set([]);

// Three classes and three cache postures. A realtime request bypasses every cache, a live one revalidates and may be up to five minutes old, and a historical one uses the browser's default.
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

// The cache-busting parameter, used by the realtime class only.
function withCacheBust(url) {
    return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
}

// A throttle is ESPN asking for fewer requests, so it is never retried at once. A 429, or any refusal carrying a Retry-After header, is reported as throttled with a bounded wait.
function throttleOf(response) {
    const header = Number(response.headers.get('Retry-After'));
    const throttled = response.status === 429 || (Number.isFinite(header) && header > 0);
    if (!throttled) return null;
    const seconds = Number.isFinite(header) && header > 0 ? header : 30;
    return Math.min(Math.max(seconds, 1), 300) * 1000;
}

// Two callers asking for the same request at the same moment share one. The first gets the parsed body and each later one gets a copy, since callers change what they receive.
const inFlightRequests = new Map();

// One season's raw parts from an archive file the reader picked. While an archive is loaded every request below is answered from it and nothing is fetched.
let archiveRaw = null;
let archiveMeta = null;

/**
 * Which league a payload is, as one string read off the payload itself.
 *
 * @param {?object} payload A league payload.
 * @returns {?string} gameId:leagueId:seasonId, or null for no payload.
 */
export function leagueKeyOf(payload) {
    return payload ? `${payload.gameId}:${payload.id}:${payload.seasonId}` : null;
}

/**
 * The archive's roster days in the slot the day race reads, keyed to the league.
 *
 * @param {?object} payload The loaded league payload.
 * @param {?object} rosters The archive's roster days, by scoring period.
 * @returns {?{key: string, days: object}} The slot, or null when there is no league or no days.
 */
export function archiveRosterSlot(payload, rosters) {
    const key = leagueKeyOf(payload);
    if (!key || !rosters) return null;
    return { key, days: rosters };
}

/**
 * Whether the dashboard is showing a league loaded from an archive file.
 *
 * @returns {boolean}
 */
export function isArchiveLoaded() {
    return !!archiveRaw;
}

/**
 * What the loaded archive says about itself, for the banner.
 *
 * @returns {?{writtenAt: string, extensionVersion: string, leagueName: string}} Null when no archive is loaded.
 */
export function archiveInfo() {
    return archiveMeta;
}

// Undefined means the archive does not hold this, and the caller throws as for a failed request. An archived session never falls through to a real fetch.
function archiveAnswerFor(url, filter) {
    if (!archiveRaw) return undefined;
    if (url.includes('/leagueHistory/')) return []; // no other seasons in a single-season archive
    if (url.includes('view=mTeam')) return archiveRaw.league;
    if (url.includes('view=kona_player_info')) {
        // The weekly request carries player ids and the whole pool request does not.
        if (filter?.players?.filterIds) return archiveRaw.weekly || { players: [] };
        return archiveRaw.pool || { players: [] };
    }
    if (url.includes('view=mDraftDetail')) return archiveRaw.draft;
    return undefined;
}

async function fetchEspnJson(url, filter) {
    if (archiveRaw) {
        const answer = archiveAnswerFor(url, filter);
        if (answer === undefined) {
            throw Object.assign(new Error('Not captured in this archive'), { authRequired: false });
        }
        return structuredClone(answer);
    }

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

/**
 * Reads an archive file the reader picked, validates it and loads its latest season with no ESPN
 * request.
 *
 * @param {File} file The file the reader picked.
 * @returns {Promise<ArchiveLoadResult>} Whether it loaded, and when it did not, why.
 */
export async function loadArchiveFile(file) {
    // The zip check comes first and reads the file's own first four bytes, never its name, so a summary export renamed to.json is named for what it is.
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
        return { ok: false, summaryZip: true };
    }
    let archive;
    try {
        archive = JSON.parse(await file.text());
    } catch (err) {
        return { ok: false, parseError: err.message };
    }
    const result = validateArchive(archive);
    if (!result.ok) return { ok: false, issues: result.issues };

    const years = archive.provenance.seasons;
    const year = Math.max(...years);
    const seasonRaw = archive.seasons[String(year)].raw;

    archiveRaw = seasonRaw;
    archiveMeta = {
        writtenAt: archive.writtenAt,
        extensionVersion: archive.provenance.extensionVersion,
        leagueName: seasonRaw.league?.settings?.name || 'league'
    };

    document.getElementById('sport').value = archive.provenance.sport;
    document.getElementById('league-id').value = String(archive.provenance.leagueId);
    const yearSelect = document.getElementById('year');
    const yearStr = String(year);
    if (!Array.from(yearSelect.options).some(o => o.value === yearStr)) {
        yearSelect.innerHTML = yearOptionsWith(Array.from(yearSelect.options).map(o => o.value), year)
            .map(y => `<option value="${y}">${y}</option>`).join('');
    }
    yearSelect.value = yearStr;

    // The same entry a Fetch press takes. Every request inside it is answered from the archive, so the app's own success path runs.
    await fetchEspnData();

    // The fetch wrote the session's cached payload as a real one would. It is erased so the next open does not repaint an archived league as a live one.
    try { await browser.storage.session.remove(['apiData', 'lastLeagueFetchKey', 'lastLeagueFetchAt']); } catch { /* no session storage - nothing to erase */ }

    // The roster days are the one part no request can answer, so they are written into the slot the race reads, keyed by the payload's own league key.
    const rosterSlot = archiveRosterSlot(AppState.apiData, seasonRaw.rosters);
    if (rosterSlot) AppState.rosterSnapshotData = rosterSlot;

    return { ok: true };
}

async function fetchEspnJsonOverWire(url, filter) {
    const headers = filter ? { 'X-Fantasy-Filter': JSON.stringify(filter) } : {};
    // Counted before the request is awaited, so one that fails still counts. A caller that joined a request already in flight is not counted, since it sent nothing.
    const kind = requestKindOf(url, filter);
    countApiRequest(url, kind);

    const klass = freshnessClassOf(url, filter);
    const init = klass === 'realtime'
        ? { credentials: 'include', headers, cache: 'no-store' }
        : klass === 'live'
            ? { credentials: 'include', headers, cache: 'no-cache' }
            : { credentials: 'include', headers };

    // Each request is logged once its outcome is known, with the time it was made, its size and whether it worked. One that never answered is logged as a failure with no size.
    let at = Date.now();
    const sendOver = async (target) => {
        try {
            return await fetch(target, init);
        } catch (e) {
            logRequest({ url, kind, at, bytes: null, ok: false });
            throw e;
        }
    };
    let response = await sendOver(klass === 'realtime' ? withCacheBust(url) : url);

    // A realtime request refused for its cache-busting parameter is retried once without it. The retry is a second request and is counted and logged as one.
    if (klass === 'realtime' && !response.ok && response.status >= 400 && response.status < 500
        && !AUTH_STATUSES.has(response.status) && response.status !== 429) {
        logRequest({ url, kind, at, bytes: null, ok: false });
        countApiRequest(url, kind);
        at = Date.now();
        response = await sendOver(url);
    }

    if (!response.ok) {
        // No size for a refusal: its body is never read, and reading it only to measure it would be a second pass over something nothing uses.
        logRequest({ url, kind, at, bytes: null, ok: false });
        // The message keeps the status for the diagnostic panel. authRequired is what the page branches on, and a Retry-After on an auth status means throttled, not signed out.
        const retryAfterMs = throttleOf(response);
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        err.throttled = retryAfterMs !== null;
        err.retryAfterMs = retryAfterMs || 0;
        err.authRequired = AUTH_STATUSES.has(response.status) && !err.throttled;
        throw err;
    }
    // The size is the body's own, read once as bytes and parsed from those bytes. It is the body as the page reads it, after any compression is undone.
    let buffer;
    try {
        buffer = await response.arrayBuffer();
    } catch (e) {
        logRequest({ url, kind, at, bytes: null, ok: false });
        throw e;
    }
    logRequest({ url, kind, at, bytes: buffer.byteLength, ok: true });
    return JSON.parse(new TextDecoder().decode(buffer));
}

/**
 * Requests the player pool of the league and season on screen, with season totals and projections.
 *
 * @returns {Promise<object>} ESPN's player pool response.
 * @throws {Error} When ESPN refuses the request. The error carries status, authRequired and throttled.
 */
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

/**
 * Requests one player's stat lines by scoring period for the season on screen.
 *
 * @param {number|string} playerId The player's ESPN id.
 * @returns {Promise<?object>} That player's entry, or null when ESPN returns none.
 * @throws {Error} When ESPN refuses the request.
 */
export async function fetchPlayerWeeklyStats(playerId) {
    // The bulk request with a single id, so there is one request shape to keep in step.
    return fetchPlayersWeeklyStatsBulk([playerId]);
}

/**
 * How many players one weekly stats request asks for.
 *
 * @type {number}
 */
export const WEEKLY_CHUNK_SIZE = 75;
/**
 * How many weekly stats requests may be in flight at once.
 *
 * @type {number}
 */
export const WEEKLY_MAX_CONCURRENT_CHUNKS = 6;

/**
 * One weekly stats request for one chunk of player ids, for the season on screen.
 *
 * @param {Array<number|string>} playerIds The ESPN player ids, at most WEEKLY_CHUNK_SIZE of them.
 * @returns {Promise<object>} ESPN's response, a players array with each player's stat lines.
 * @throws {Error} When ESPN refuses the request.
 */
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

async function fetchPlayersWeeklyStatsBulk(playerIds) {
    const chunks = [];
    for (let i = 0; i < playerIds.length; i += WEEKLY_CHUNK_SIZE) {
        chunks.push(playerIds.slice(i, i + WEEKLY_CHUNK_SIZE));
    }

    const responses = await runWithConcurrencyLimit(chunks, WEEKLY_MAX_CONCURRENT_CHUNKS, fetchPlayersWeeklyChunk);

    // Every chunk's players are merged into one response, so the caller need not know the request was split.
    return { players: responses.flatMap(r => r.players || []) };
}

/**
 * Requests a season's draft and returns its picks.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {string|number} year The season.
 * @returns {Promise<object[]>} The picks, or an empty array when the league has none or the request fails.
 * @throws {Error} Only when ESPN throttles the request, so a paced queue can wait and retry.
 */
export async function fetchDraftDetail(sport, leagueId, year) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mDraftDetail`;
        const data = await fetchEspnJson(url);
        // Stored raw for the diagnostic panel, before the picks are unwrapped, since the draft's settings and keeper fields sit outside the picks.
        setDebugContext('draft-detail', data);
        return (data && data.draftDetail && data.draftDetail.picks) || [];
    } catch (e) {
        // A throttle is rethrown so the queue can slow down and retry. Swallowed, it would read as a season with no draft.
        if (e && e.throttled) throw e;
        return [];
    }
}

/**
 * The league's most recent past season, for the card shown before a draft.
 *
 * @returns {Promise<?object>} That season's league payload, or null for a first-season league or a
 *   season that could not be read.
 */
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

/**
 * Fetches the loaded league's draft for the diagnostic panel when it holds none.
 *
 * @returns {Promise<void>}
 */
export async function ensureDraftDetailCapture() {
    if (hasDebugContext('draft-detail') || !AppState.apiData) return;
    const { sport, leagueId, year } = getLeagueParams();
    if (!sport || !leagueId || !year) return;
    setDebugLoading('draft-detail', true);
    try {
        await fetchDraftDetail(sport, leagueId, year);
    } finally {
        // The loading line is cleared here for the failure path, so a league whose draft cannot be read does not leave it showing.
        setDebugLoading('draft-detail', false);
    }
}

// One scoring period's transactions. ESPN answers for the current period unless one is named, and a batch of periods in one request returned nothing, so the harvest is one request a period.
async function fetchTransactionPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTransactions2&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        // One period is stored for the diagnostic panel only until a harvest has written the whole log.
        if (!(debugContextFor('transactions') || {}).harvest) setDebugContext('transactions', data);
        return (data && data.transactions) || [];
    } catch (e) {
        // A throttle or a refusal is rethrown so the queue and its breaker see it. Swallowed, it would read as a period with no moves.
        if (isRefusal(e)) throw e;
        return [];
    }
}

/**
 * Requests a season's whole transaction log, one request per scoring period, merged and with
 * duplicates removed.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {string|number} year The season.
 * @param {number} firstScoringPeriod The first scoring period to ask for.
 * @param {number} finalScoringPeriod The last scoring period to ask for.
 * @returns {Promise<object[]>} The transactions.
 */
export async function harvestTransactions(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);
    return (await harvestTransactionLog(sport, leagueId, year, periods)).transactions;
}

/**
 * Requests the transactions of the scoring periods named and says how far the harvest got.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {string|number} year The season.
 * @param {number[]} periods The scoring periods to ask for.
 * @returns {Promise<{transactions: object[], asked: number, got: number, error: ?string}>} The merged
 *   log, the periods asked for, the periods that answered, and the refusal that stopped it if one did.
 */
export async function harvestTransactionLog(sport, leagueId, year, periods) {
    let tripped = null;
    // The watched pacing, since the day race draws nothing until this arrives and is on screen while it does.
    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchTransactionPeriod(sport, leagueId, year, period), FOREGROUND_PACING,
        { stopAfter: REFUSALS_BEFORE_STOP, onTrip: (e) => { tripped = e; } });

    const byId = new Map();
    slices.flat().forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
    const transactions = Array.from(byId.values());
    const got = slices.filter(s => Array.isArray(s)).length;
    if (got > 0) {
        setDebugContext('transactions', {
            seasonId: Number(year), harvest: { periodsAsked: periods.length, periodsAnswered: got }, transactions
        });
    }
    return { transactions, asked: periods.length, got, error: tripped ? (tripped.message || String(tripped)) : null };
}

// The pro schedule is a season request with no league id and no cookies. It is fetched once per sport and season and kept for the session, and a failed fetch is silent. The key is spelled in this one function so reader and writer cannot drift.
function proScheduleKey(sport, year) {
    return `proTeamSchedules:${sport}:${year}`;
}

/**
 * The stored pro schedule, only when it belongs to this sport and season.
 *
 * @param {?{key: string, data: ?object}} store The stored schedule.
 * @param {string} sport The sport code.
 * @param {string|number} year The season.
 * @returns {?object} The schedule, or null when the store holds another sport's or season's.
 */
export function proScheduleFor(store, sport, year) {
    return store && store.key === proScheduleKey(sport, year) ? store.data : null;
}

/**
 * The pro schedule for the league on screen.
 *
 * @returns {?object} The schedule, or null.
 */
export function currentProSchedule() {
    const { sport, year } = getLeagueParams();
    return proScheduleFor(AppState.proTeamSchedules, sport, year);
}

/**
 * Whether this sport and season's schedule has been asked for, which is true of a failed fetch
 * too.
 *
 * @param {?{key: string, data: ?object}} store The stored schedule.
 * @param {string} sport The sport code.
 * @param {string|number} year The season.
 * @returns {boolean}
 */
export function proScheduleAttemptedFor(store, sport, year) {
    return !!store && store.key === proScheduleKey(sport, year);
}

/**
 * Whether the schedule for the league on screen has been asked for.
 *
 * @returns {boolean}
 */
export function proScheduleAttempted() {
    const { sport, year } = getLeagueParams();
    return proScheduleAttemptedFor(AppState.proTeamSchedules, sport, year);
}

// One read and one write of local storage, under every named pair below. A stored value that is falsy reads as missing, and a storage error reads as nothing stored and writes as false.
async function readLocal(key, missing = null) {
    try {
        const got = await browser.storage.local.get(key);
        return (got && got[key]) || missing;
    } catch { return missing; }
}

async function writeLocal(key, value) {
    try {
        await browser.storage.local.set({ [key]: value });
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads a stored preseason snapshot.
 *
 * @param {string} key The snapshot's storage key.
 * @returns {Promise<?object>} The snapshot, or null when none is stored or storage is unavailable.
 */
export async function readPreseasonSnapshot(key) {
    return readLocal(key);   // storage unavailable is "no snapshot", which every reader handles
}

/**
 * Every preseason snapshot key now in storage.
 *
 * @returns {Promise<string[]>}
 */
export async function preseasonSnapshotKeys() {
    try {
        const all = await browser.storage.local.get(null);
        return Object.keys(all || {}).filter(k => k.startsWith('preseason:'));
    } catch { return []; }
}

/**
 * Stores a preseason snapshot, then removes the stale ones named.
 *
 * @param {string} key The snapshot's storage key.
 * @param {object} value The snapshot.
 * @param {string[]} [stale] Keys to remove once the new snapshot is stored.
 * @returns {Promise<boolean>} False when the snapshot could not be stored.
 */
export async function writePreseasonSnapshot(key, value, stale) {
    // Over quota or storage disabled. The feature is absent, not broken.
    if (!(await writeLocal(key, value))) return false;
    if (stale && stale.length) {
        try { await browser.storage.local.remove(stale); } catch { /* the new one is stored; old ones can wait */ }
    }
    return true;
}

/**
 * The storage key for a league's team nicknames.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @returns {string}
 */
export function nicknamesKey(sport, leagueId) {
    return `nicknames:${sport}:${leagueId}`;
}

// Never null, since every caller looks a team up in it at once.
async function readNicknames(key) {
    return readLocal(key, {});
}

/**
 * Stores a league's team nicknames.
 *
 * @param {string} key The key nicknamesKey gives.
 * @param {Object<string, string>} value The nicknames by team id.
 * @returns {Promise<boolean>} False when they could not be stored.
 */
export async function writeNicknames(key, value) {
    return writeLocal(key, value);   // over quota or storage disabled - the edit is not saved, not thrown
}

// Started and not awaited after every league load. The names are applied only if the league they were read for is still the one on screen.
async function loadNicknames() {
    const { sport, leagueId } = getLeagueParams();
    if (!leagueId) return;
    const key = nicknamesKey(sport, leagueId);
    const stored = await readNicknames(key);
    const { sport: nowSport, leagueId: nowLeagueId } = getLeagueParams();
    if (nicknamesKey(nowSport, nowLeagueId) !== key) return;
    AppState.nicknames = new Map(Object.entries(stored));
    buildNicknamesSheet();
    if (AppState.nicknames.size) renderActiveLeagueView();
}

/**
 * The storage key for a league's draft plan.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @returns {string}
 */
export function draftPlanKey(sport, leagueId) {
    return `draftPlan:${sport}:${leagueId}`;
}

/**
 * Reads a league's stored draft plan.
 *
 * @param {string} key The key draftPlanKey gives.
 * @returns {Promise<?object>} The plan, or null when none is stored.
 */
export async function readDraftPlan(key) {
    return readLocal(key);
}

/**
 * Stores a league's draft plan.
 *
 * @param {string} key The key draftPlanKey gives.
 * @param {object} value The plan.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeDraftPlan(key, value) {
    return writeLocal(key, value);   // over quota or storage disabled - the edit is not saved, not thrown
}

/**
 * The storage key for the reader's notes on players in a league's draft. The notes have a key of
 * their own so that clearing a plan never removes them.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @returns {string}
 */
export function draftNotesKey(sport, leagueId) {
    return `draftNotes:${sport}:${leagueId}`;
}

/**
 * Reads the reader's stored draft notes.
 *
 * @param {string} key The key draftNotesKey gives.
 * @returns {Promise<?object>} The notes, or null when none are stored.
 */
export async function readDraftNotes(key) {
    return readLocal(key);
}

/**
 * Stores the reader's draft notes.
 *
 * @param {string} key The key draftNotesKey gives.
 * @param {object} value The notes.
 * @returns {Promise<boolean>} False when they could not be stored.
 */
export async function writeDraftNotes(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for the width the reader dragged a league's draft tray to.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @returns {string}
 */
export function draftTrayWidthKey(sport, leagueId) {
    return `draftTrayWidth:${sport}:${leagueId}`;
}

/**
 * Reads the stored draft tray width.
 *
 * @param {string} key The key draftTrayWidthKey gives.
 * @returns {Promise<?number>} The width, or null when none is stored.
 */
export async function readDraftTrayWidth(key) {
    return readLocal(key);
}

/**
 * Stores the draft tray width.
 *
 * @param {string} key The key draftTrayWidthKey gives.
 * @param {number} value The width.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeDraftTrayWidth(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for a league's draft pick log, kept apart from the plan so each can be cleared
 * without the other.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @returns {string}
 */
export function draftLogKey(sport, leagueId) {
    return `draftLog:${sport}:${leagueId}`;
}

/**
 * Reads a league's stored pick log.
 *
 * @param {string} key The key draftLogKey gives.
 * @returns {Promise<?object>} The log, or null when none is stored.
 */
export async function readDraftLog(key) {
    return readLocal(key);
}

/**
 * Stores a league's pick log.
 *
 * @param {string} key The key draftLogKey gives.
 * @param {object} value The log.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeDraftLog(key, value) {
    return writeLocal(key, value);
}

// The draft room's snapshot sits under one fixed key in local storage, which a content script can write in both browsers. The league is a field of the value, so a page checks relevance by reading it.
const ROOM_STATE_KEY = 'roomState';

/**
 * Reads the snapshot the draft room reader last wrote.
 *
 * @returns {Promise<?object>} The snapshot, or null when there is none.
 */
export async function readRoomState() {
    return readLocal(ROOM_STATE_KEY);
}

/**
 * Reads a cached playoff odds record.
 *
 * @param {string} key The cache key.
 * @returns {Promise<?object>} The record, or null when nothing is cached.
 */
export async function readOddsCache(key) {
    return readLocal(key);   // unavailable storage is "nothing cached", which recomputes
}

/**
 * Stores a playoff odds record.
 *
 * @param {string} key The cache key.
 * @param {object} record The record.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeOddsCache(key, record) {
    return writeLocal(key, record);   // over quota or storage disabled - the answer stands, it is not kept
}

/**
 * The storage key for the rankings file the reader chose for a league. The file's text and name
 * are stored, never the parsed rows, so each load matches it against the pool then loaded.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @returns {string}
 */
export function rankingsFileKey(sport, leagueId) {
    return `rankingsFile:${sport}:${leagueId}`;
}

/**
 * Reads the stored rankings file.
 *
 * @param {string} key The key rankingsFileKey gives.
 * @returns {Promise<?{name: string, text: string}>} The file, or null when none is stored.
 */
export async function readRankingsFile(key) {
    return readLocal(key);
}

/**
 * Stores the reader's rankings file.
 *
 * @param {string} key The key rankingsFileKey gives.
 * @param {{name: string, text: string}} value The file's name and text.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeRankingsFile(key, value) {
    return writeLocal(key, value);
}

/**
 * Removes the stored rankings file.
 *
 * @param {string} key The key rankingsFileKey gives.
 * @returns {Promise<boolean>} False when storage refused.
 */
export async function removeRankingsFile(key) {
    try {
        await browser.storage.local.remove(key);
        return true;
    } catch {
        return false;
    }
}

/**
 * The storage key for the scouting page's pool file. The scouting page reads files and no ESPN
 * league, so its keys carry no sport or league id.
 *
 * @returns {string}
 */
export function scoutPoolKey() {
    return 'scoutPool';
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutPool(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutPool(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for the scouting page's eligibility file, a second file kept apart from the
 * pool so each can be cleared and replaced without the other.
 *
 * @returns {string}
 */
export function scoutEligibleKey() {
    return 'scoutEligible';
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutEligible(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutEligible(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for the scouting page's optional prospect ranking file.
 *
 * @returns {string}
 */
export function scoutRankingKey() {
    return 'scoutRanking';
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutRanking(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutRanking(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for the scouting page's optional lines sheet.
 *
 * @returns {string}
 */
export function scoutLinesKey() {
    return 'scoutLines';
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutLines(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutLines(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for the scouting page's optional draft pedigree files, stored as a list since
 * several can be loaded at once.
 *
 * @returns {string}
 */
export function scoutPedigreeKey() {
    return 'scoutPedigree';
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutPedigree(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutPedigree(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for a scouting plan, by the league name the reader types.
 *
 * @param {string} leagueName The league's name as typed.
 * @returns {string}
 */
export function scoutPlanKey(leagueName) {
    return `scoutPlan:${leagueName}`;
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutPlan(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutPlan(key, value) {
    return writeLocal(key, value);
}

/**
 * The storage key for the reader's scouting notes, by the league name the reader types.
 *
 * @param {string} leagueName The league's name as typed.
 * @returns {string}
 */
export function scoutNotesKey(leagueName) {
    return `scoutNotes:${leagueName}`;
}

/**
 * Reads what the scouting page stored under a key.
 *
 * @param {string} key The storage key.
 * @returns {Promise<?object>} The stored value, or null when there is none.
 */
export async function readScoutNotes(key) {
    return readLocal(key);
}

/**
 * Stores a value for the scouting page.
 *
 * @param {string} key The storage key.
 * @param {object} value The value to store.
 * @returns {Promise<boolean>} False when it could not be stored.
 */
export async function writeScoutNotes(key, value) {
    return writeLocal(key, value);
}

/**
 * Drops the pro schedule held in memory and in session storage for the league on screen, so the
 * next request for it asks the network.
 *
 * @returns {Promise<void>}
 */
export async function invalidateStoredProSchedule() {
    const { sport, year } = getLeagueParams();
    const key = proScheduleKey(sport, year);
    if (AppState.proTeamSchedules && AppState.proTeamSchedules.key === key) AppState.proTeamSchedules = null;
    try { await browser.storage.session.remove(key); } catch { /* nothing stored, nothing to drop */ }
}

/**
 * The pro schedule for the sport and season on screen, from memory, then session storage, then
 * ESPN.
 *
 * @returns {Promise<?object>} The schedule, or null when it could not be fetched.
 */
export async function fetchProTeamSchedules() {
    const { sport, year } = getLeagueParams();
    const key = proScheduleKey(sport, year);
    // The diagnostic panel is given the schedule on every path, from memory and from session storage as well as from the network, since it describes what the app holds.
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

/**
 * Requests today's scoreboard, which is where ESPN carries betting lines. It is kept in memory by
 * sport and hour and never in session storage, since a line moves during the day.
 *
 * @returns {Promise<?object>} The scoreboard, or null for a sport with none or a failed request.
 */
export async function fetchScoreboardOdds() {
    const { sport, year } = getLeagueParams();
    // A table and not a two-way choice, so a sport with no scoreboard path gets no odds instead of another sport's.
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

/**
 * Requests every team's roster for one scoring period of the league on screen.
 *
 * @param {number} scoringPeriodId The scoring period.
 * @returns {Promise<Array<{id: number, entries: Array<{p: number, slot: number}>}>>} Each team with
 *   its players and the lineup slot each sat in. Empty when the request fails.
 */
export async function fetchRosterForPeriod(scoringPeriodId) {
    const { sport, leagueId, year } = getLeagueParams();
    return fetchRosterPeriod(sport, leagueId, year, scoringPeriodId);
}

/**
 * The last scoring period of a league's season.
 *
 * @param {?object} apiData A league payload.
 * @returns {?number} The final scoring period, else the latest, else null.
 */
export function finalScoringPeriodOf(apiData) {
    const st = (apiData || {}).status || {};
    return st.finalScoringPeriod || st.latestScoringPeriod || null;
}

/**
 * Fetches the loaded league's rosters for the diagnostic panel when it holds none.
 *
 * @returns {Promise<void>}
 */
export async function ensureRosterCapture() {
    if (hasDebugContext('roster') || !AppState.apiData) return;
    const period = finalScoringPeriodOf(AppState.apiData);
    if (!period) return;
    setDebugLoading('roster', true);
    try {
        await fetchRosterForPeriod(period);
    } finally {
        // The loading line is cleared here for the failure path, so a league whose rosters cannot be read does not leave it showing.
        setDebugLoading('roster', false);
    }
}

// One scoring period's rosters, every team's with the lineup slot each player sat in that day, reduced to the shape the timeline reads. A missing field drops that entry and never throws.
async function fetchRosterPeriod(sport, leagueId, year, scoringPeriodId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mRoster&scoringPeriodId=${scoringPeriodId}`;
        const data = await fetchEspnJson(url);
        // Stored raw for the diagnostic panel, before the reduction below drops the fields the timeline does not need.
        setDebugContext('roster', data);
        return (data && data.teams || []).map(t => ({
            id: t.id,
            entries: ((t.roster && t.roster.entries) || [])
                .map(e => ({ p: e.playerId, slot: e.lineupSlotId }))
                .filter(e => e.p != null && e.slot != null)
        }));
    } catch (e) {
        // A throttle or a refusal is rethrown so the queue and its breaker see it. Swallowed, it would read as a day with no lineups.
        if (isRefusal(e)) throw e;
        return [];
    }
}

/**
 * Requests a season's daily rosters, one request per scoring period.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {string|number} year The season.
 * @param {number} firstScoringPeriod The first scoring period to ask for.
 * @param {number} finalScoringPeriod The last scoring period to ask for.
 * @returns {Promise<RosterHarvest>} The days that answered, and how far the harvest got.
 */
export async function harvestRosters(sport, leagueId, year, firstScoringPeriod, finalScoringPeriod) {
    const periods = [];
    for (let p = firstScoringPeriod; p <= finalScoringPeriod; p++) periods.push(p);
    return harvestRosterPeriods(sport, leagueId, year, periods);
}

/**
 * Requests the daily rosters of the scoring periods named.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {string|number} year The season.
 * @param {number[]} periods The scoring periods to ask for.
 * @returns {Promise<RosterHarvest>} The days that answered, and how far the harvest got.
 */
export async function harvestRosterPeriods(sport, leagueId, year, periods) {
    // The watched pacing, for the same reason the transaction harvest uses it.
    let tripped = null;
    const slices = await runWithConcurrencyLimit(periods, WEEKLY_MAX_CONCURRENT_CHUNKS,
        (period) => fetchRosterPeriod(sport, leagueId, year, period), FOREGROUND_PACING,
        { stopAfter: REFUSALS_BEFORE_STOP, onTrip: (e) => { tripped = e; } });

    const days = {};
    periods.forEach((period, i) => {
        const teams = slices[i] || [];
        if (teams.length) days[period] = teams;
    });
    // How far the harvest got. A day that answered with no lineup still counts as answered.
    return { days, asked: periods.length, got: slices.filter(s => Array.isArray(s)).length,
        error: tripped ? (tripped.message || String(tripped)) : null };
}

// ==== Download All's steps ====

/**
 * Runs one capture step's work and counts the requests the page made while it ran.
 *
 * @param {?function(number): void} report Called twice a second with the count so far.
 * @param {function(): Promise<?object>} work The step's work.
 * @returns {Promise<object>} What the work returned, with requests added.
 */
export async function countedCapture(report, work) {
    const start = getRequestTally().api.total;
    const made = () => getRequestTally().api.total - start;
    const tick = setInterval(() => { if (typeof report === 'function') report(made()); }, 500);
    try {
        const result = (await work()) || {};
        return { ...result, requests: made() };
    } finally {
        clearInterval(tick);
    }
}

// What a response weighs, measured and rounded up, since an estimate that reads low is the one a reader resents.
const CAPTURE_BYTES = {
    leagueHistory: 6000,
    draftDetail: 120000,
    proSchedule: 1700000,
    rosterPerTeam: 330000,       // one mRoster response: 1.24 MB at 6 teams, 4.25 MB at 13
    transactionsPerPeriod: 14000
};

// The cheap set for each past season is three requests: its league payload, its pool and its draft. The transaction log and the daily lineups stay with the season on screen.
const SEASON_POOL_BYTES = { fhl: 5700000, flb: 12300000, ffl: 3000000 };
/**
 * The capture steps for a league's past seasons: three for each, its league payload, its pool
 * and its draft.
 *
 * @param {Array<number|string>} years The league's seasons. The season on screen is left out.
 * @returns {object[]} The steps, newest season first, in the shape the capture runner takes.
 */
export function seasonCaptureSteps(years) {
    const { sport, leagueId } = getLeagueParams();
    const current = Number((AppState.apiData || {}).seasonId);
    const past = [...new Set((years || []).map(Number))].filter(y => Number.isFinite(y) && y > 0 && y !== current).sort((a, b) => b - a);
    const step = (season, kind, bytes, work) => ({
        kind, season,
        present: () => hasSeasonDebugContext(season, kind),
        estimate: () => ({ requests: 1, bytes }),
        run: (report) => countedCapture(report, async () => {
            await work();
            return hasSeasonDebugContext(season, kind) ? { asked: 1, got: 1 } : { asked: 1, got: 0, ok: false, error: 'no response' };
        })
    });
    return past.flatMap(season => [
        step(season, 'team', 1200000, async () => {
            try { const payload = await fetchSeasonPayload(sport, leagueId, season); if (payload) setSeasonDebugContext(season, 'team', payload); }
            catch { /* absent, and the step says so */ }
        }),
        step(season, 'player-pool', SEASON_POOL_BYTES[sport] ?? null, async () => {
            try { const pool = await fetchSeasonPool(sport, leagueId, season); if (pool) setSeasonDebugContext(season, 'player-pool', pool); }
            catch { /* absent, and the step says so */ }
        }),
        // fetchDraftDetail writes the kind itself, and a draft that names another season is routed to that season's slot by the store.
        step(season, 'draft-detail', CAPTURE_BYTES.draftDetail, async () => {
            try { await fetchDraftDetail(sport, leagueId, season); } catch { /* absent */ }
        })
    ]);
}

/**
 * The capture steps for the league and season on screen whose requests live in this module.
 *
 * @param {object} [options]
 * @param {boolean} [options.oddsOn=false] Whether the reader has betting lines turned on.
 * @returns {object[]} The steps, in the shape the capture runner takes.
 */
export function captureStepsFor({ oddsOn = false } = {}) {
    const { sport, leagueId } = getLeagueParams();
    const league = AppState.apiData || {};
    const year = league.seasonId;
    const status = league.status || {};
    const teams = (league.teams || []).length;
    // The days played, not the season's whole length, so no request is spent on a day that has not happened.
    const first = Number(status.firstScoringPeriod) || 1;
    const last = Math.min(Number(status.latestScoringPeriod) || 0, Number(status.finalScoringPeriod) || 0);
    const periods = [];
    for (let p = first; p <= last; p++) periods.push(p);
    const notPlayed = () => (periods.length ? null : 'no scoring period has been played');

    // A kind one request fills. Whether it worked is read off the diagnostic store afterwards, since these calls swallow their own errors.
    const oneShot = (kind, bytes, work) => ({
        kind,
        present: () => hasDebugContext(kind),
        estimate: () => ({ requests: 1, bytes }),
        run: (report) => countedCapture(report, async () => {
            await work();
            return hasDebugContext(kind) ? { asked: 1, got: 1 } : { asked: 1, got: 0, ok: false, error: 'no response' };
        })
    });

    return [
        { kind: 'team', present: () => hasDebugContext('team'), estimate: () => ({ requests: 0, bytes: 0 }),
            run: async () => ({ asked: 1, got: 0, ok: false, error: 'no league is loaded' }) },
        oneShot('league-history', CAPTURE_BYTES.leagueHistory, () => fetchLeagueHistorySeasons(sport, leagueId)),
        oneShot('draft-detail', CAPTURE_BYTES.draftDetail, () => ensureDraftDetailCapture()),
        oneShot('pro-schedule', CAPTURE_BYTES.proSchedule, () => fetchProTeamSchedules()),
        oneShot('roster', CAPTURE_BYTES.rosterPerTeam * teams, () => ensureRosterCapture()),
        {
            kind: 'transactions',
            // Held only as the whole log. One period left behind by another view is not it.
            present: () => !!(debugContextFor('transactions') || {}).harvest,
            skip: notPlayed,
            estimate: () => ({ requests: periods.length, bytes: periods.length * CAPTURE_BYTES.transactionsPerPeriod }),
            run: (report) => countedCapture(report, async () => {
                const log = await harvestTransactionLog(sport, leagueId, year, periods);
                return { asked: log.asked, got: log.got, refused: log.asked - log.got, error: log.error,
                    counts: { periods: log.got, transactions: log.transactions.length } };
            })
        },
        {
            kind: 'roster-days',
            present: () => hasDebugContext('roster-days'),
            skip: notPlayed,
            // The bytes fetched, not kept. What is kept is reduced to a few kilobytes a day.
            estimate: () => ({ requests: periods.length, bytes: periods.length * teams * CAPTURE_BYTES.rosterPerTeam }),
            run: (report) => countedCapture(report, async () => {
                const out = await harvestRosterPeriods(sport, leagueId, year, periods);
                const days = Object.keys(out.days).length;
                if (days) setDebugContext('roster-days', out.days);
                return { asked: out.asked, got: out.got, refused: out.asked - out.got, error: out.error, counts: { days } };
            })
        },
        {
            kind: 'odds',
            present: () => hasDebugContext('odds'),
            // Opt-in stays opt-in. The scoreboard is requested only when the reader has turned betting lines on, and a download does not turn them on.
            skip: () => (oddsOn ? null : 'betting lines are off'),
            estimate: () => ({ requests: 1, bytes: null }),
            run: (report) => countedCapture(report, async () => {
                const data = await fetchScoreboardOdds();
                return data ? { asked: 1, got: 1 } : { asked: 1, got: 0, ok: false, error: 'no scoreboard for this sport, or no response' };
            })
        }
    ];
}

// The league history endpoint is scoped to this sport and league, so it is the source for which seasons the league has. It is best effort and never blocks the main fetch.
async function fetchLeagueHistorySeasons(sport, leagueId) {
    try {
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/leagueHistory/${leagueId}`;
        const seasons = await fetchEspnJson(url);
        // Stored for the diagnostic panel so the shape of the array can be read off a real league.
        setDebugContext('league-history', seasons);
        return (seasons || []).map(s => s.seasonId).filter(Boolean);
    } catch {
        return [];
    }
}

// One past season's league payload, with the views the current season's fetch asks for, since League History reads the same fields. Each season is requested directly.
async function fetchSeasonPayload(sport, leagueId, year) {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam&view=mMatchupScore&view=mSettings`;
    return fetchEspnJson(url);
}

// Kept per season for the session. A finished season cannot change, and the cache is per league so one league's past is never served as another's.
const seasonCache = new Map();

/**
 * Loads the league payload of each past season named, one request a season, kept for the session.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {Array<number|string>} years The seasons wanted.
 * @param {function(number, number): void} [onProgress] Called with seasons done and seasons wanted.
 * @returns {Promise<Object<string, object>>} The payloads by season. A season that could not be read is absent.
 */
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
                // One unreadable season never costs the others. It is absent from the history, and the view says so.
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

// One past season's player pool, for the career table. It is the most expensive request League History makes, so it runs only when the career table is opened. The filter asks for real season totals only, which is a fraction of the unfiltered size.
async function fetchSeasonPool(sport, leagueId, year) {
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

/**
 * Loads the player pool of each past season named, as real season totals, one request a season,
 * kept for the session.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {Array<number|string>} years The seasons wanted.
 * @param {function(number, number): void} [onProgress] Called with seasons done and seasons wanted.
 * @returns {Promise<Object<string, object>>} The pools by season. A season that could not be read is absent.
 */
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
                // One unreadable year is one year missing from the careers, not a failed table.
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

// Every franchise that held a player, per season, built from the season's draft and transaction log. A season whose log cannot be read falls back to the roster at the time of the fetch.
const ownershipCache = new Map();

// The draft picks are cached apart from the ownership map, so a season whose log was not walked does not ask for its draft twice. Only a result with picks in it is cached, since an empty one cannot be told from a failed request.
const historyDraftPicksCache = new Map();

/**
 * Which teams held each player in each season named, from the season's draft and its transaction
 * log.
 *
 * The drafts arrive first, one request a season, and the table can draw on them. The logs follow,
 * one request per scoring period, and refine each season as it completes.
 *
 * @param {string} sport The sport code.
 * @param {string|number} leagueId The league id.
 * @param {Array<number|string>} years The seasons wanted.
 * @param {Object<string, object>} payloadsByYear Each season's league payload, for its scoring periods.
 * @param {OwnershipOptions} [options] Callbacks, and what is already in hand.
 * @returns {Promise<Object<string, object>>} By season, each player's team ids. A season with neither a
 *   draft nor a log is absent.
 */
export async function loadHistoryOwnership(sport, leagueId, years, payloadsByYear, options = {}) {
    const { onDrafts, onSeason, onProgress, onRefused, liveSeason, liveSeasonPending, fullLogYears } = options;
    const wanted = [...new Set(years || [])].filter(Boolean).sort((a, b) => a - b);

    const owners = {};
    const pending = [];

    // Anything already in hand resolves without a request: a season harvested earlier in the session, or the live season when the day race has its log.
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

    // Every pending season's draft is fetched, one request each. The transaction walk runs only for the seasons the caller names, and a season left out keeps draft-only attribution and is never cached as final.
    const walkSet = fullLogYears ? new Set(fullLogYears) : null;
    let walkYears = walkSet ? pending.filter(y => walkSet.has(y)) : [...pending];

    // A live season whose log another view is already fetching is not walked a second time. Its slot waits on that fetch and still gets its draft in the first phase.
    const joinYear = liveSeasonPending && walkYears.includes(liveSeasonPending.year)
        ? liveSeasonPending.year : null;
    if (joinYear !== null) walkYears = walkYears.filter(y => y !== joinYear);
    const deferredYears = pending.filter(y => !walkYears.includes(y) && y !== joinYear);

    // The first phase is the drafts, one request a season. They attribute every player who was drafted and never moved.
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

    // The draft maps go straight into the one result map and are overwritten season by season as logs arrive, so no intermediate state is missing a season.
    pending.forEach(year => {
        const picks = picksByYear[year];
        if (picks.length) owners[year] = ownerTeamIdsByPlayer(buildRosterTimeline({ picks }));
    });
    // The table can render now on draft attribution while the logs arrive. The caller is told which seasons are still refining and which were left out.
    const refiningYears = joinYear === null ? [...walkYears] : [...walkYears, joinYear];
    if (onDrafts) onDrafts(owners, refiningYears, [...deferredYears]);

    // The second phase is every season and period as one task list through the same queue. A season with no period bounds has nothing to walk and keeps its draft attribution.
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

    // A season that stopped short has a partial log. It is published without being cached, so a retry asks again.
    const finish = (year, { cache = true } = {}) => {
        const key = `${sport}:${leagueId}:${year}`;
        const picks = picksByYear[year] || [];
        // Duplicates are removed by id, since ESPN can repeat a transaction that spans periods in more than one period's answer.
        const byId = new Map();
        (txByYear[year] || []).forEach(t => { if (t && t.id != null && !byId.has(t.id)) byId.set(t.id, t); });
        const transactions = [...byId.values()];
        const map = (picks.length || transactions.length)
            ? ownerTeamIdsByPlayer(buildRosterTimeline({ picks, transactions }))
            : null;
        if (cache) ownershipCache.set(key, map);
        // Null only when the season had neither picks nor transactions. The year then stays absent and the caller falls back for it.
        if (map) owners[year] = map;
        if (onSeason) onSeason(year, owners);
    };

    // A walked season with no periods is done once its draft is in. A season left out is not finished here, since that would cache a draft-only map as final.
    walkYears.filter(year => !remaining.has(year)).forEach(finish);

    let done = 0;
    // A refusal is the host's and not one season's, so it stops the whole task list.
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

    // The joined season runs beside the walk, not before it. If the fetch it waits on fails, the season is walked here as it would have been.
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

    // A season the walk never finished is finished here with what arrived, so the view completes late and never hangs. After a refusal the caller is told which seasons stopped short.
    const short = [];
    remaining.forEach((left, year) => { if (left > 0) { short.push(year); finish(year, { cache: !refused }); } });
    if (refused && onRefused) onRefused(short);

    return owners;
}

// Runs after every successful league fetch, whoever started it. It is registered from outside because the work it does lives in a module this one cannot import without a cycle.
let postFetchHook = null;
/**
 * Registers the function run after every successful league fetch.
 *
 * @param {function({reopenPlayerId: *}): (void|Promise<void>)} fn The hook.
 * @returns {void}
 */
export function setPostFetchHook(fn) { postFetchHook = fn; }

// ==== Every league at once ====

/**
 * How long a game is taken to run, by sport, in milliseconds. No ESPN response carries a game's end,
 * so a game is called over this long after its start. Each figure is set long, so a game is called
 * over late and never early.
 *
 * @type {Object<string, number>}
 */
export const GAME_LENGTH_MS = { fhl: 165 * 60000, flb: 195 * 60000, ffl: 210 * 60000 };

/**
 * The rules the every-league model needs for one league, read from the validated slot and stat
 * catalogs and the league's own scoring settings.
 *
 * @param {string} sport The sport code.
 * @param {?object} payload The league payload.
 * @returns {LeagueTodayRules}
 */
export function leagueTodayRules(sport, payload) {
    const nonStarting = [...(NON_STARTING_SLOTS[sport] || [])].sort((a, b) => a - b);
    const labels = LINEUP_SLOT_LABELS[sport] || {};
    const items = payload && payload.settings && payload.settings.scoringSettings && payload.settings.scoringSettings.scoringItems;
    return {
        benchSlots: nonStarting.filter(id => labels[id] === 'BE'),
        nonStartingSlots: nonStarting,
        // Skaters and goalies share one games id in hockey. A baseball pitcher's line carries no batting games, so a pitcher's trend reads as none.
        gamesId: (GAMES_PLAYED_IDS[sport] || {}).primary ?? null,
        gameLengthMs: GAME_LENGTH_MS[sport] ?? null,
        categoryIds: Array.isArray(items) ? items.map(i => String(i.statId)) : [],
        rateIds: [...(AVERAGE_STATS[sport] || [])]
    };
}

// A record the lookup marked. One cached before the marks were read carries none and is treated as a league with no lookup entry, so the payload decides.
const hasLookupMarks = (record) => !!record && typeof record.drafted === 'boolean';

/**
 * Why a league request failed, in the two words a view needs.
 *
 * @param {?Error} error The error the request threw.
 * @returns {'auth'|'error'} 'auth' when ESPN refused the session, 'error' for anything else.
 */
export function failureReasonOf(error) {
    return error && error.authRequired === true ? 'auth' : 'error';
}

// One budget for the whole call. Every request of every league goes through one queue, three lanes wide.
const LEAGUES_TODAY_LANES = 3;

// The raw answers of the last call, in memory only, so a redraw inside five minutes recomputes against a new clock without a request.
let leaguesTodayCache = null;

// The built model is kept in session storage under the same five minutes, so a page reopened inside them sends nothing. The raw answers are never stored. The key carries the account, so a login switch never shows another account's lineups.
const leaguesTodayStoreKey = (swid) => `leaguesToday:${swid || ''}`;

async function fetchProScheduleFor(sport, year) {
    const key = proScheduleKey(sport, year);
    if (AppState.proTeamSchedules && AppState.proTeamSchedules.key === key && AppState.proTeamSchedules.data) return AppState.proTeamSchedules.data;
    try {
        const cached = await browser.storage.session.get(key);
        if (cached && cached[key]) return cached[key];
    } catch { /* session storage unavailable, fall through to the network */ }
    const data = await fetchEspnJson(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${year}?view=proTeamSchedules_wl`);
    // The same per-sport-and-season key fetchProTeamSchedules reads, so the ordinary open finds it.
    try { await browser.storage.session.set({ [key]: data }); } catch { /* over quota, the caller still has it */ }
    return data;
}

/**
 * Fetches every active league of the account, its payload, its roster view and its sport's pro
 * schedule, and builds the every-league model from them.
 *
 * The leagues are fetched into plain objects and handed to the model. Nothing is written to the one
 * league the rest of the app shows. A league that fails does not sink the others, and it is named
 * with why. Not yet called by any view.
 *
 * @param {object} [options]
 * @param {DiscoveredLeague[]} [options.records] The leagues to consider. Defaults to those discovered.
 * @param {number} [options.now] The clock, in milliseconds.
 * @param {boolean} [options.force=false] Skip the five-minute memory and the stored model.
 * @returns {Promise<object>} The model, with fetchedAt and a failed list of {key, reason}.
 * @throws {Error} When ESPN throttles past what the queue will wait for.
 */
export async function fetchLeaguesToday({ records = discoveredLeagues, now = Date.now(), force = false } = {}) {
    const wanted = (records || []).filter(r => activeByLookup(hasLookupMarks(r) ? r : null).keep);
    const cacheKey = wanted.map(r => `${r.key}:${r.seasonId}`).join('|');
    let raw = leaguesTodayCache;
    const fresh = (held) => !!held && held.key === cacheKey && now - held.at < LEAGUE_REVALIDATE_MIN_MS;
    const storeKey = leaguesTodayStoreKey(AppState.userSwid);
    // The stored model serves a page that has no memory of its own. Forcing skips it, and a changed league list fails its key.
    if (!force && !fresh(raw)) {
        try {
            const held = (await browser.storage.session.get(storeKey))[storeKey];
            // Each row's game state is asked again against the new clock.
            if (fresh(held) && Array.isArray(held.leagues)) {
                return { ...leaguesTodayAt(held, now), fetchedAt: held.at, failed: held.failed || [] };
            }
        } catch { /* no session storage - fetch as before */ }
    }
    if (force || !fresh(raw)) {
        const scheduleKeys = Array.from(new Set(wanted.map(r => `${r.sport}:${r.seasonId}`)));
        const items = [
            ...scheduleKeys.map(k => ({ kind: 'schedule', sport: k.split(':')[0], year: Number(k.split(':')[1]) })),
            ...wanted.map(record => ({ kind: 'league', record }))
        ];
        const tolerate = async (work) => {
            try { return await work(); } catch (e) { if (e && e.throttled) throw e; return null; }
        };
        const answers = await runWithConcurrencyLimit(items, LEAGUES_TODAY_LANES, async (item) => {
            if (item.kind === 'schedule') return tolerate(() => fetchProScheduleFor(item.sport, item.year));
            const { sport, leagueId, seasonId } = item.record;
            let reason = null;
            const payload = await tolerate(() => fetchEspnJson(leagueUrl(sport, leagueId, seasonId)).catch(e => {
                if (!e || !e.throttled) reason = failureReasonOf(e);
                throw e;
            }));
            if (!payload) return { payload: null, rosterView: null, reason: reason || 'error' };
            const period = payload.scoringPeriodId ?? (payload.status && payload.status.latestScoringPeriod);
            const rosterView = await tolerate(() => fetchEspnJson(
                `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${sport}/seasons/${seasonId}/segments/0/leagues/${leagueId}?view=mRoster&scoringPeriodId=${period}`));
            return { payload, rosterView, reason: null };
        }, FOREGROUND_PACING);
        const schedules = new Map(scheduleKeys.map((k, i) => [k, answers[i] || null]));
        raw = {
            key: cacheKey, at: now,
            leagues: wanted.map((record, i) => ({
                record,
                // An item the queue never ran (its throttle gate gave up) is a failure too.
                ...(answers[scheduleKeys.length + i] || { payload: null, rosterView: null, reason: 'error' }),
                proSchedule: schedules.get(`${record.sport}:${record.seasonId}`) || null
            }))
        };
        leaguesTodayCache = raw;
    }
    const inputs = raw.leagues.map(l => ({
        payload: l.payload,
        rosterView: l.rosterView,
        proSchedule: l.proSchedule,
        // The reader's team is matched by account first, which is the only way that works for a league entered by hand, and then by the lookup's own team id.
        teamId: findOwnedTeamId(l.payload && l.payload.teams, AppState.userSwid) ?? l.record.teamId ?? null,
        rules: leagueTodayRules(l.record.sport, l.payload),
        record: hasLookupMarks(l.record) ? l.record : null
    }));
    const built = {
        ...leaguesToday(inputs, { now }),
        fetchedAt: raw.at,
        failed: raw.leagues.filter(l => !l.payload).map(l => ({ key: l.record.key, reason: l.reason || 'error' }))
    };
    // Written on every answer built from the raw answers, so the stored copy is never older than the memory it stands in for.
    try {
        await browser.storage.session.set({ [storeKey]: { key: cacheKey, at: raw.at, leagues: built.leagues, failed: built.failed } });
    } catch { /* over quota or no session storage - the memory copy still serves this page */ }
    return built;
}

/**
 * Fetches the league the reader has entered, stores it for the session and redraws the dashboard.
 * A failure is shown to the reader and is not thrown.
 *
 * @returns {Promise<void>}
 */
export async function fetchEspnData() {
    const { sport, leagueId, year } = getLeagueParams();

    if (!leagueId) return alert("Enter a League ID.");
    await browser.storage.local.set({ sport, leagueId, year });

    // Captured before the league data is reset below, so a player view that is open reopens against the league just fetched.
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
        // A league's list of seasons does not change within a session, so one already stored for this league is reused. The key has no year in it, since the list is the same whichever season is fetched.
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
        loadNicknames();
        succeeded = true;
    } catch (error) {
        // A private league read with no cookies fails outright. The failure is recorded so the login watcher can retry it, and the message names the action and not the status.
        AppState.leagueDataError = error.authRequired ? { authRequired: true } : null;
        alert(error.authRequired
            ? 'Log into ESPN in this browser, then fetch again.'
            : `Error: ${error.message}`);
    } finally {
        btn.textContent = "Fetch Data";
        btn.disabled = false;
    }

    // Outside the try on purpose. A failure in the hook is a rendering problem and must not be reported as a failed fetch.
    if (succeeded && postFetchHook) await postFetchHook({ reopenPlayerId });
}
