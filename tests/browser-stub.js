// DEV-ONLY stub of the WebExtension `browser` API, used solely by dev-preview.html (which is not referenced by manifest.json and never ships). Lets the full dashboard run on a plain static server with a REAL captured league payload (one of the espn-debug-*.json dumps in the JSON_debug/ folder) preloaded as if it were the extension's session cache - no ESPN cookies or network needed. Anything that does hit the network (fan-profile discovery, the player pool) fails and takes its normal, already-handled error path. Pick a different payload with ?payload=<filename>, e.g. dev-preview.html?payload=espn-debug-1783444838686.json (bare filenames resolve into JSON_debug/; pass a path with "/" to point anywhere else) Two extra switches for screenshots and offline player work: ?anon=1 - renames every fantasy team to an invented one with its own abbreviation (and blanks member names) before the dashboard sees the payload, so screenshots of real league data carry no real team names. Player rows inherit the renamed teams because players.js maps teamId -> team through the league payload, not through the player payload's own strings. ?players=<file> - serves a captured player-pool JSON (the debug panel's "Player Pool Schema" download) for the pool fetch, so the Player Metrics tab runs offline. Weekly-stats fetches (same endpoint, but sent with a filterStatsForTopScoringPeriodIds filter header) are answered with an empty-but-valid pool - see the interception comment below. ?poolstatus=<code> - refuses the pool fetch with that HTTP status, everything else normal. ?poolstatus=405 is the logged-out session. ?proteam=<file> - serves a captured proTeamSchedules_wl response, which is what My Team's Schedule face needs to place projected starts on days. Without it that one request goes to real ESPN, so offline every calendar day renders empty - the face loads but has nothing in it to size against. ?noleague=1 - the FRESH-INSTALL state: no stored league, no cached payload, so nothing auto-fetches and the page renders only its entry chrome. This is what the browser-action popup shows the first time it is ever opened, and until now the harness could not produce it - which is how a header row with no header row silently stopped redirecting to a full tab. ?scoreboard=<file> - serves a captured scoreboard response, which is where the betting lines on the Schedule cards come from. Without it that request goes to real ESPN, so offline no card carries a line - which is also the shape to stage deliberately, since odds cover today's slate only and most cards never have one. Pass a no-odds capture to test that path. ?playersDelay=<ms> - holds the player pool back. Captures resolve off disk in a few ms, so a ?payloadDelay=<ms> driven click can never land BEFORE the pool settles and the LOADING state ?proteamDelay=<ms> the owner keeps entering had never once been rendered here - which is why three rounds of My Team fit bugs were reasoned about rather than staged. payloadDelay does the same for the league payload, which is the league-switch variant. Timing assertions belong against these clocks: a driven click lands late and reflexes are not evidence.
(function () {
    if (window.browser) return;

    const params = new URLSearchParams(location.search);
    const payloadName = params.get('payload') || 'espn-debug-1783444818700.json';
    const payloadFile = payloadName.includes('/') ? payloadName : `JSON_debug/${payloadName}`;
    const anonymize = params.get('anon') === '1';
    const noLeague = params.get('noleague') === '1';
    const poolStatus = parseInt(params.get('poolstatus'), 10) || 0;
    window.__stubLoggedOut = params.get('nocookies') === '1';
    // Flips the fake session to logged in and pokes the same watcher a real login would (B91's focus layer), so the recovery runs through the real path rather than a hand-fired event. Clears ?poolstatus too, since a login that leaves the pool still refused is not a login.
    window.__stubLogIn = () => {
        window.__stubLoggedOut = false;
        window.__stubPoolStatusCleared = true;
        window.dispatchEvent(new Event('focus'));
    };

    // Invented names, in the register a real fantasy league writes in, because "Team 1" through "Team 4" reads as a broken screenshot rather than an anonymized one - and these shots go on store listings. Each carries its own abbreviation, since the standings bars, the leaderboard's team column and the heatmap axis all show the short form and a mechanical "T1" gives the same placeholder impression the long name just escaped. Location and nickname are split the way ESPN splits them so a surface joining the two still reads correctly. Nothing here is drawn from any real league. The list wraps, so a league larger than it still anonymizes - with a numeric suffix, so two teams never collide.
    const ANON_TEAMS = [
        ['Bunt', 'Force Trauma', 'BFT'], ['Big', 'Inning', 'BIG'], ['Walk Off', 'Warriors', 'WOW'],
        ['Rally', 'Caps', 'RC'], ['Designated', 'Sitters', 'DS'], ['Full', 'Count Club', 'FCC'],
        ['Wild', 'Pitches', 'WP'], ['Bat', 'Attitudes', 'BA'], ['Seventh Inning', 'Kings', 'SIK'],
        ['Extra Innings', 'Empire', 'EIE'], ['Foul', 'Territory', 'FT'], ['Cellar', 'Dwellers', 'CD']
    ];

    const anonymizePayload = (data) => {
        if (!data?.teams) return data;
        data.teams.forEach((t, i) => {
            const [location, nickname, abbrev] = ANON_TEAMS[i % ANON_TEAMS.length];
            const wrap = Math.floor(i / ANON_TEAMS.length);
            const suffix = wrap ? ` ${wrap + 1}` : '';
            if ('name' in t) t.name = `${location} ${nickname}${suffix}`;
            if ('location' in t) t.location = location;
            if ('nickname' in t) t.nickname = `${nickname}${suffix}`;
            if ('abbrev' in t) t.abbrev = `${abbrev}${wrap ? wrap + 1 : ''}`;
        });
        (data.members || []).forEach((m, i) => {
            if ('displayName' in m) m.displayName = `Manager ${i + 1}`;
            if ('firstName' in m) m.firstName = 'Manager';
            if ('lastName' in m) m.lastName = String(i + 1);
        });
        return data;
    };

    // Falls back to the bundled anonymized sample league when no captured payload exists - so a fresh clone (a contributor, or an AMO reviewer without an ESPN account) can run the full dashboard with zero setup. The sample is committed; JSON_debug/ never is.
    const SAMPLE_FILE = 'tests/sample-league.json';
    const fetchJson = (file) => fetch(file).then(r => r.ok ? r.json() : null).catch(() => null);
    // One place for every staged delay, so a reader sees at once that these are harness clocks and not something the app waits on.
    const delayMs = (name) => Number(params.get(name) || 0);
    const held = (ms, make) => (ms ? new Promise(resolve => setTimeout(() => resolve(make()), ms)) : make());
    const payloadDelayMs = delayMs('payloadDelay');
    const playersDelayMs = delayMs('playersDelay');
    const payloadPromise = held(payloadDelayMs, () => fetchJson(payloadFile))
        .then(data => data || fetchJson(SAMPLE_FILE))
        .then(data => (data && anonymize) ? anonymizePayload(data) : data);

    // kona_player_info interception, two cases told apart by the scoring-period filter header: - The pool request is served from the captured ?players= file when one is given, and passes through otherwise (its failure is the tab's own already-handled error state). - Weekly-stats requests are answered with an empty-but-valid pool. A static page can never complete them for real (they need ESPN cookie auth), and letting them fail put two red fetch errors in the console on EVERY dev-preview load (the leaderboard warm-up in players.js prefetchPlayerData fires them unprompted), burying real errors during verification. The empty success means the app caches empty per-player weekly stubs, so offline a WINDOWED timeframe computes empty aggregates instead of showing the bulk- fetch error state - the honest trade was console noise on every load vs a degraded state only on a view the offline harness can't support anyway; the info line below is the breadcrumb for anyone testing windowed timeframes offline. A fresh Response per call, since a Response body can only be consumed once and the bulk fetch is chunked.
    const playersName = params.get('players');
    const playersFile = playersName && (playersName.includes('/') ? playersName : `JSON_debug/${playersName}`);

    const scoreboardName = params.get('scoreboard');
    const scoreboardFile = scoreboardName && (scoreboardName.includes('/') ? scoreboardName : `JSON_debug/${scoreboardName}`);
    const proteamName = params.get('proteam');
    const proteamFile = proteamName && (proteamName.includes('/') ? proteamName : `JSON_debug/${proteamName}`);
    // &proteamDelay=<ms> holds the schedule back the way the real fetch does. Served instantly, the Schedule face exists before the tab is ever entered and the re-fit that arriving starts triggers can never land while that face is on screen - which is the one moment the fit is decided against a layout the other face has to live with too ( follow-up).
    const proteamDelayMs = delayMs('proteamDelay');

    // ?weekly=<file>&weeklyDelay=<ms> - the weekly-loading harness. Without it, weekly requests answer with an empty pool (see the note below), which is enough for "does the page survive offline" but can't exercise anything about HOW the weekly data arrives. With it, the stub indexes a real captured bulk weekly payload by player id and answers each chunk request with exactly the ids that request asked for, after an artificial per-chunk delay - so chunk ORDER, progressive pop-in, scroll/sort reprioritization, and a drill-down jumping the queue are all observable and deterministic offline. Every served chunk is appended to window.__stubWeeklyChunks ({at, count, ids}) as the record to assert ordering against.
    const weeklyName = params.get('weekly');
    const weeklyFile = weeklyName && (weeklyName.includes('/') ? weeklyName : `JSON_debug/${weeklyName}`);
    const weeklyDelayMs = Number(params.get('weeklyDelay') || 250);
    window.__stubWeeklyChunks = [];
    // Parsed once and shared. These captures run to tens of MB, so re-reading per chunk would dwarf the very latency the harness is trying to simulate.
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

    // ?draft=<file>&transactions=<file> - the transaction-accurate roster harness. The draft request (view=mDraftDetail) is answered with the draft file; each per-period transaction request (view=mTransactions2&scoringPeriodId=N) is answered by filtering the merged transaction fixture down to that period, exactly as the real harvest sees ESPN's per-period slices. Without these params the requests fall through to the real network (and fail offline), so the race stays on its current-roster fallback - which is itself a valid thing to test.
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

    // ?rosters=<file> - the started-accurate roster harness. Each per-period roster request (view=mRoster&scoringPeriodId=N) is answered from the distilled snapshot fixture ({ days: { N: [{ id, entries: [{ p, slot }] }] } }), REBUILT into ESPN's raw mRoster shape (teams[].roster.entries[].playerId/lineupSlotId) so fetchRosterPeriod's real parser runs against it offline, not just the distilled form. Without the param the request falls through to the real network (and fails offline), so the race stays on the transaction/current fallback tiers.
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
        if (scoreboardFile && u.includes('/scoreboard')) {
            return held(delayMs('scoreboardDelay'), () => realFetch(scoreboardFile));
        }
        if (proteamFile && u.includes('proTeamSchedules_wl')) {
            return held(proteamDelayMs, () => realFetch(proteamFile));
        }
        const isKona = typeof url === 'string' && url.includes('kona_player_info');
        if (!isKona) return realFetch(url, options);
        const filterHeader = options?.headers?.['X-Fantasy-Filter'] || '';
        if (filterHeader.includes('filterStatsForTopScoringPeriodIds')) {
            if (weeklyFile) return serveWeeklyChunk(filterHeader);
            // Window-scoped once-flag (not a closure let) so the note prints once per page no matter how many chunked requests, or stub instances, ever run.
            if (!window.__stubWeeklyNoted) {
                window.__stubWeeklyNoted = true;
                console.info('browser-stub: weekly player stats are unavailable offline. This serves an empty pool, so the leaderboard falls back to season totals and windowed timeframes stay empty. Pass ?weekly=<file> to replay a captured bulk payload instead.');
            }
            return Promise.resolve(new Response('{"players": []}', { headers: { 'Content-Type': 'application/json' } }));
        }
        // ?poolstatus=<code> refuses the pool with that status and nothing else, which is exactly what a logged-out ESPN session looks like. The league read still succeeds when restrictionType is NONE, and only the filtered pool request is turned away, with 405 rather than the 401 anyone would expect. Without this the state can be described but not reproduced, and it is the first thing a new user sees if they are not logged in.
        if (poolStatus && !window.__stubPoolStatusCleared) {
            return Promise.resolve(new Response('', { status: poolStatus, statusText: 'Stubbed' }));
        }
        return playersFile ? held(playersDelayMs, () => realFetch(playersFile)) : realFetch(url, options);
    };

    window.browser = {
        cookies: {
            // Fake cookies so checkAuth passes and the dashboard renders clean; the league picker's fan-profile fetch fails harmlessly (it's already best-effort). SWID is derived from whichever payload is loaded (the first team's own primaryOwner), not hardcoded - so "My Team" auto-detection (recap.js detectMyTeamId) has a real match against ANY payload passed via ?payload=, not just one fixed league.
            get: async ({ name }) => {
                // ?nocookies=1 starts the page logged OUT. window.__stubLogIn() then flips it, which is the only way to exercise the mid-session login recovery. The real trigger is checkAuth going green, and it can only go green if it was red first.
                if (window.__stubLoggedOut) return null;
                const apiData = await payloadPromise;
                const owner = apiData?.teams?.find(t => t.primaryOwner)?.primaryOwner;
                return { name, value: owner || '' };
            }
        },
        storage: {
            local: {
                // Sport and year are derived from the loaded payload (gameId: 2 = baseball/flb, 4 = hockey/fhl; seasonId is the year) so any capture loads with the right stat maps and the right season - processPlayerData matches player stat lines by seasonId === year, so a hardcoded year would leave every player with empty season totals whenever the payload is from a different season. Falls back to flb.
                get: async () => {
                    if (noLeague) return {};
                    const apiData = await payloadPromise;
                    const sport = apiData?.gameId === 4 ? 'fhl' : 'flb';
                    const year = String(apiData?.seasonId || '2025');
                    return { sport, leagueId: 'dev-preview', year };
                },
                set: async () => {}
            },
            session: {
                get: async () => {
                    if (noLeague) return {};
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
        // RECORDED, not swallowed. main.js redirects a popup to a full tab through this call, and whether it fires is the single fact that separates a working popup from B142's sliver - so the harness needs to see it happen. Still a no-op otherwise, because the harness is a tab.
        tabs: { create: async (arg) => { (window.__stubTabsCreated = window.__stubTabsCreated || []).push(arg); } },
        // Always granted, so the dev flow never sees the Firefox opt-in prompt checkAuth renders for a store install (see hasEspnHostAccess in api.js). request() is here for shape only: nothing in dev-preview can reach it while contains() answers true.
        permissions: {
            contains: async () => true,
            request: async () => true
        },
        runtime: { getURL: (p) => p }
    };
})();
