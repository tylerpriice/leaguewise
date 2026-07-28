// Dev-only stub of the WebExtension browser API, used by dev-preview.html, which manifest.json never references and which never ships. It lets the full dashboard run on a plain static server against a captured or bundled payload, with no ESPN cookies and no network.
// Query params: ?payload=<file> picks the league capture, ?anon=1 renames every team before the dashboard sees the payload, ?players=<file> serves a captured player pool, ?weekly=<file> with ?weeklyDelay=<ms> replays chunked weekly fetches, and ?draft=, ?transactions= and ?rosters= feed the roster harnesses.
(function () {
    if (window.browser) return;

    const params = new URLSearchParams(location.search);
    const payloadName = params.get('payload') || 'espn-debug-1783444818700.json';
    const payloadFile = payloadName.includes('/') ? payloadName : `JSON_debug/${payloadName}`;
    const anonymize = params.get('anon') === '1';
    const poolStatus = parseInt(params.get('poolstatus'), 10) || 0;
    window.__stubLoggedOut = params.get('nocookies') === '1';
    // Flips the fake session to logged in and pokes the same watcher a real login would, so the recovery runs through the real path rather than a hand-fired event. Clears ?poolstatus too, since a login that leaves the pool still refused is not a login.
    window.__stubLogIn = () => {
        window.__stubLoggedOut = false;
        window.__stubPoolStatusCleared = true;
        window.dispatchEvent(new Event('focus'));
    };

    const anonymizePayload = (data) => {
        if (!data?.teams) return data;
        data.teams.forEach((t, i) => {
            const label = `Team ${i + 1}`;
            if ('name' in t) t.name = label;
            if ('location' in t) t.location = 'Team';
            if ('nickname' in t) t.nickname = String(i + 1);
            if ('abbrev' in t) t.abbrev = `T${i + 1}`;
        });
        (data.members || []).forEach((m, i) => {
            if ('displayName' in m) m.displayName = `Manager ${i + 1}`;
            if ('firstName' in m) m.firstName = 'Manager';
            if ('lastName' in m) m.lastName = String(i + 1);
        });
        return data;
    };

    // Falls back to the bundled anonymized sample league when no captured payload exists, so a fresh clone runs the whole dashboard with zero setup.
    const SAMPLE_FILE = 'tests/sample-league.json';
    const fetchJson = (file) => fetch(file).then(r => r.ok ? r.json() : null).catch(() => null);
    const payloadPromise = fetchJson(payloadFile)
        .then(data => data || fetchJson(SAMPLE_FILE))
        .then(data => (data && anonymize) ? anonymizePayload(data) : data);

    // Two cases, told apart by the scoring-period filter header. A pool request is served from the captured file when one was given, while weekly-stats requests are answered with an empty but valid pool, since a static page can never complete them for real and their failures would bury real errors in the console. A fresh Response per call, because a body can only be consumed once.
    const playersName = params.get('players');
    const playersFile = playersName && (playersName.includes('/') ? playersName : `JSON_debug/${playersName}`);

    // The weekly-loading harness indexes a captured bulk payload by player id and answers each chunk with exactly the ids it asked for, after an artificial delay, so chunk order, progressive rendering and reprioritization are observable offline. Every served chunk is recorded on window.__stubWeeklyChunks.
    const weeklyName = params.get('weekly');
    const weeklyFile = weeklyName && (weeklyName.includes('/') ? weeklyName : `JSON_debug/${weeklyName}`);
    const weeklyDelayMs = Number(params.get('weeklyDelay') || 250);
    window.__stubWeeklyChunks = [];
    // Parsed once and shared, since these captures run to tens of MB and re-reading per chunk would dwarf the latency the harness is simulating.
    const weeklyIndexPromise = weeklyFile ? fetchJson(weeklyFile).then(data => {
        const index = new Map();
        (data?.players || []).forEach(entry => {
            const id = entry?.id ?? entry?.player?.id;
            if (id != null) index.set(Number(id), entry);
        });
        console.info(`browser-stub: weekly harness ready: ${index.size} players indexed from ${weeklyFile}, ${weeklyDelayMs}ms per chunk.`);
        return index;
    }) : null;

    async function serveWeeklyChunk(filterHeader) {
        const index = await weeklyIndexPromise;
        let ids = [];
        try { ids = JSON.parse(filterHeader)?.players?.filterIds?.value || []; } catch { /* unparseable filter - serve empty */ }
        const players = ids.map(id => index.get(Number(id))).filter(Boolean);
        await new Promise(resolve => setTimeout(resolve, weeklyDelayMs));
        window.__stubWeeklyChunks.push({ at: Math.round(performance.now()), count: ids.length, ids: ids.slice() });
        return new Response(JSON.stringify({ players }), { headers: { 'Content-Type': 'application/json' } });
    }

    // The draft request is answered with the draft file, and each per-period transaction request is filtered down to that period exactly as the real harvest sees ESPN's slices. Without the params the requests fall through and the race stays on its fallback.
    const draftName = params.get('draft');
    const draftFile = draftName && (draftName.includes('/') ? draftName : `JSON_debug/${draftName}`);
    const txName = params.get('transactions');
    const txFile = txName && (txName.includes('/') ? txName : `JSON_debug/${txName}`);
    const draftPromise = draftFile ? fetchJson(draftFile) : null;
    const txPromise = txFile ? fetchJson(txFile).then(data => {
        const byPeriod = new Map();
        (data?.transactions || []).forEach(t => {
            const p = t?.scoringPeriodId;
            if (p == null) return;
            if (!byPeriod.has(p)) byPeriod.set(p, []);
            byPeriod.get(p).push(t);
        });
        window.__stubTransactionPeriods = 0;
        console.info(`browser-stub: transaction harness ready: ${(data?.transactions || []).length} transactions across ${byPeriod.size} periods from ${txFile}.`);
        return byPeriod;
    }) : null;

    async function serveTransactionPeriod(url) {
        const byPeriod = await txPromise;
        const m = /[?&]scoringPeriodId=(\d+)/.exec(url);
        const period = m ? Number(m[1]) : null;
        const transactions = (period != null && byPeriod.get(period)) || [];
        window.__stubTransactionPeriods = (window.__stubTransactionPeriods || 0) + 1;
        return new Response(JSON.stringify({ transactions }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Each per-period roster request is answered from the snapshot fixture rebuilt into ESPN's raw shape, so the real parser runs against it offline rather than only the distilled form.
    const rostersName = params.get('rosters');
    const rostersFile = rostersName && (rostersName.includes('/') ? rostersName : `JSON_debug/${rostersName}`);
    const rostersPromise = rostersFile ? fetchJson(rostersFile).then(data => {
        const days = (data && data.days) || {};
        window.__stubRosterPeriods = 0;
        console.info(`browser-stub: roster snapshot harness ready: ${Object.keys(days).length} daily snapshots from ${rostersFile}.`);
        return days;
    }) : null;

    async function serveRosterPeriod(url) {
        const days = await rostersPromise;
        const m = /[?&]scoringPeriodId=(\d+)/.exec(url);
        const period = m ? m[1] : null;
        const dayTeams = (period != null && days[period]) || [];
        const teams = dayTeams.map(t => ({
            id: t.id,
            roster: { entries: (t.entries || []).map(e => ({ playerId: e.p, lineupSlotId: e.slot })) }
        }));
        window.__stubRosterPeriods = (window.__stubRosterPeriods || 0) + 1;
        return new Response(JSON.stringify({ teams }), { headers: { 'Content-Type': 'application/json' } });
    }

    const realFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
        const u = typeof url === 'string' ? url : '';
        if (draftPromise && u.includes('view=mDraftDetail')) {
            return draftPromise.then(d => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }));
        }
        if (txPromise && u.includes('view=mTransactions2')) {
            return serveTransactionPeriod(u);
        }
        if (rostersPromise && u.includes('view=mRoster')) {
            return serveRosterPeriod(u);
        }
        const isKona = typeof url === 'string' && url.includes('kona_player_info');
        if (!isKona) return realFetch(url, options);
        const filterHeader = options?.headers?.['X-Fantasy-Filter'] || '';
        if (filterHeader.includes('filterStatsForTopScoringPeriodIds')) {
            if (weeklyFile) return serveWeeklyChunk(filterHeader);
            // A window-scoped flag, so the note prints once per page however many chunked requests or stub instances run.
            if (!window.__stubWeeklyNoted) {
                window.__stubWeeklyNoted = true;
                console.info('browser-stub: weekly player stats are unavailable offline. This serves an empty pool, so the leaderboard falls back to season totals and windowed timeframes stay empty. Pass ?weekly=<file> to replay a captured bulk payload instead.');
            }
            return Promise.resolve(new Response('{"players": []}', { headers: { 'Content-Type': 'application/json' } }));
        }
        // ?poolstatus=<code> refuses the pool with that status and nothing else, which is what a logged-out ESPN session looks like from the dashboard's side.
        if (poolStatus && !window.__stubPoolStatusCleared) {
            return Promise.resolve(new Response('', { status: poolStatus, statusText: 'Stubbed' }));
        }
        return playersFile ? realFetch(playersFile) : realFetch(url, options);
    };

    window.browser = {
        cookies: {
            // Fake cookies so the auth check passes and the dashboard renders clean. The SWID is derived from whichever payload is loaded rather than hardcoded, so team auto-detection has a real match against any of them.
            get: async ({ name }) => {
                // ?nocookies=1 starts the page logged OUT. window.__stubLogIn() then flips it, which is the only way to exercise the mid-session login recovery: the real trigger is checkAuth going green, and it can only go green if it was red first.
                if (window.__stubLoggedOut) return null;
                const apiData = await payloadPromise;
                const owner = apiData?.teams?.find(t => t.primaryOwner)?.primaryOwner;
                return { name, value: owner || '' };
            }
        },
        storage: {
            local: {
                // Sport and year are derived from the loaded payload, since player stat lines are matched by season and a hardcoded year would leave every player with empty totals whenever the capture is from another one.
                get: async () => {
                    const apiData = await payloadPromise;
                    const sport = apiData?.gameId === 4 ? 'fhl' : 'flb';
                    const year = String(apiData?.seasonId || '2025');
                    return { sport, leagueId: 'dev-preview', year };
                },
                set: async () => {}
            },
            session: {
                get: async () => {
                    const apiData = await payloadPromise;
                    if (!apiData) {
                        console.error(`browser-stub: couldn't load payload "${payloadFile}"`);
                        return {};
                    }
                    return { apiData, leagueHistoryYears: [] };
                },
                set: async () => {}
            }
        },
        tabs: { create: async () => {} },
        // Always granted, so the dev flow never sees the opt-in prompt a store install gets.
        permissions: {
            contains: async () => true,
            request: async () => true
        },
        runtime: { getURL: (p) => p }
    };
})();
