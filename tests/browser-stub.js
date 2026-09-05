// DEV-ONLY stub of the WebExtension `browser` API, used solely by dev-preview.html (which is not referenced by manifest.json and never ships). Lets the full dashboard run on a plain static server with a REAL captured league payload (one of the espn-debug-*.json dumps in the JSON_debug/ folder) preloaded as if it were the extension's session cache - no ESPN cookies or network needed. Anything that does hit the network (fan-profile discovery, the player pool) fails and takes its normal, already-handled error path. Pick a different payload with ?payload=<filename>, e.g. dev-preview.html?payload=espn-debug-1783444838686.json (bare filenames resolve into JSON_debug/; pass a path with "/" to point anywhere else) Two extra switches for screenshots and offline player work: ?anon=1 - renames every fantasy team to an invented one with its own abbreviation (and blanks member names) before the dashboard sees the payload, so screenshots of real league data carry no real team names. Player rows inherit the renamed teams because players.js maps teamId -> team through the league payload, not through the player payload's own strings. ?capture=<dir> - loads a WHOLE captured league from a Download All directory (team.json, roster.json, draft-detail.json, player-pool.json). The app fetches those through four different ESPN views, so a surface that reads all four - the graded card wants rosters AND picks AND the pool - cannot be staged from any single ?payload= file. ?players= still wins if given. ?preseason=1 - rewinds the loaded league AND ITS POOL to the day after its draft, by REMOVING the evidence of play (each team's valuesByStat and record) before the dashboard sees it. Not a flag the app reads: season-state.js still reads the payload and answers honestly, so there is no override the product could ever take by accident. Lets a mid-season capture stage the two preseason faces with its own real rosters, picks and projections. ?players=<file> - serves a captured player-pool JSON (the debug panel's "Player Pool Schema" download) for the pool fetch, so the Player Metrics tab runs offline. Weekly-stats fetches (same endpoint, but sent with a filterStatsForTopScoringPeriodIds filter header) are answered with an empty-but-valid pool - see the interception comment below. ?poolstatus=<code> - refuses the pool fetch with that HTTP status, everything else normal. ?txstatus=<code> - refuses every per-period transaction request AFTER the first &txokfirst=<n> ?txokfirst=<n> with that status (429 for a throttle, 401 for an expired session). Stages a host that starts refusing partway through a walk, which is the only way to measure what a circuit breaker actually saves. ?poolstatus=405 is the logged-out session. ?proteam=<file> - serves a captured proTeamSchedules_wl response, which is what My Team's Schedule face needs to place projected starts on days. Without it that one request goes to real ESPN, so offline every calendar day renders empty - the face loads but has nothing in it to size against. ?noleague=1 - the FRESH-INSTALL state: no stored league, no cached payload, so nothing auto-fetches and the page renders only its entry chrome. This is what the browser-action popup shows the first time it is ever opened, and until now the harness could not produce it - which is how a header row with no header row silently stopped redirecting to a full tab. ?seasons=<y:file,..> - serves captured league payloads for PAST seasons, which is what the League History view fetches one per year. Also answers the leagueHistory year list from the same argument, so the view discovers exactly these years. Without it a history view has only the current season to show. ?seasonpools=<y:file,..> - serves a captured PLAYER POOL per season, which is what the career table fetches when it is opened - the live season included, since careers count it. Pass captures filtered to season totals, since that is what the real request asks for: the same league unfiltered is 52 MB against 2 MB filtered, and replaying the fat one stages a response the extension never receives. ?historyomit=<y,..> - drops those years from the leagueHistory ANSWER while still serving their payloads. That is what ESPN really does: the stub omits unfinished seasons (docs/DATA-SOURCES.md section 9), so the current season is missing from it while being perfectly fetchable. Without this the harness could not stage item 3 at all, because ?seasons= answered the stub with every year it could serve and the bug needs the two lists to differ. ?scoreboard=<file> - serves a captured scoreboard response, which is where the betting lines on the Schedule cards come from. Without it that request goes to real ESPN, so offline no card carries a line - which is also the shape to stage deliberately, since odds cover today's slate only and most cards never have one. Pass a no-odds capture to test that path. ?playersDelay=<ms> - holds the player pool back. Captures resolve off disk in a few ms, so a ?payloadDelay=<ms> driven click can never land BEFORE the pool settles and the LOADING state ?proteamDelay=<ms> the owner keeps entering had never once been rendered here - which is why three rounds of My Team fit bugs were reasoned about rather than staged. payloadDelay does the same for the league payload, which is the league-switch variant. Timing assertions belong against these clocks: a driven click lands late and reflexes are not evidence.
(function () {
    if (window.browser) return;

    const params = new URLSearchParams(location.search);
    // The bundled anonymized sample league, and it is declared HERE rather than beside its fetch because it is now the DEFAULT rather than only the fallback - see payloadFile just below.
    const SAMPLE_FILE = 'tests/sample-league.json';
    // ASKING FOR NOTHING GETS THE SAMPLE, not a capture that is not there. This used to default to a named file under JSON_debug/, a directory that is never committed and never mirrored. That was harmless here, where the file exists, and wrong in the public repo: a contributor or a store reviewer cloning it and opening dev-preview.html got, as the page's FIRST console line, a 404 naming the owner's private capture directory and one specific private capture's filename. The page then worked - the fallback below is deliberate and lands on the committed sample - but a published file should not open by announcing the shape and name of something only its author has. The loud error is not weakened, only aimed: it now fires when a capture somebody ACTUALLY NAMED failed to load, which is the case S10 wrote it for, and never on a clone that asked for nothing at all.
    const payloadName = params.get('payload');
    const payloadFile = payloadName
        ? (payloadName.includes('/') ? payloadName : `JSON_debug/${payloadName}`)
        : SAMPLE_FILE;
    const anonymize = params.get('anon') === '1';
    const captureDir = (params.get('capture') || '').replace(/\/$/, '');
    const asPreseason = params.get('preseason') === '1';
    const captureFile = (name) => `${captureDir}/${name}`;
    const noLeague = params.get('noleague') === '1';
    const poolStatus = parseInt(params.get('poolstatus'), 10) || 0;
    window.__stubLoggedOut = params.get('nocookies') === '1';
    // Flips the fake session to logged in and pokes the same watcher a real login would, so the recovery runs through the real path rather than a hand-fired event. Clears ?poolstatus too, since a login that leaves the pool still refused is not a login.
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

    // The sample is what a fresh clone (a contributor, or a store reviewer without an ESPN account) runs the full dashboard on with zero setup. It is committed; JSON_debug/ never is. SAMPLE_FILE itself is declared at the top now, because it is the default and not only the fallback.
    const fetchJson = (file) => fetch(file).then(r => r.ok ? r.json() : null).catch(() => null);
    // One place for every staged delay, so a reader sees at once that these are harness clocks and not something the app waits on.
    const delayMs = (name) => Number(params.get(name) || 0);
    const held = (ms, make) => (ms ? new Promise(resolve => setTimeout(() => resolve(make()), ms)) : make());
    const payloadDelayMs = delayMs('payloadDelay');
    const playersDelayMs = delayMs('playersDelay');
    // ONE LEAGUE OUT OF FOUR FILES. The capture directory holds what four separate ESPN views returned, so putting them back together here is what the app's own fetches do across a session - the rosters ride the team in mRoster, and the picks live in mDraftDetail.
    const composeCapture = async () => {
        const [league, rosters, draft] = await Promise.all([
            fetchJson(captureFile('team.json')),
            fetchJson(captureFile('roster.json')),
            fetchJson(captureFile('draft-detail.json'))
        ]);
        if (!league) return null;
        const rosterById = new Map((rosters?.teams || []).map(t => [t.id, t.roster]));
        (league.teams || []).forEach(t => { if (rosterById.has(t.id)) t.roster = rosterById.get(t.id); });
        if (draft?.draftDetail) league.draftDetail = draft.draftDetail;
        return league;
    };

    // REWOUND BY SUBTRACTION, never by a flag. A league is in preseason when nobody has posted a stat line, so taking the stat lines away is not a lie about the payload - it IS the payload a league has the week before it starts. season-state.js reads it and answers for itself, which is why this can never leak into the product as a fallback: there is nothing here for the product to read. Everything the faces then draw - rosters, picks, projections - is the real capture's own.
    const rewindToPreseason = (data) => {
        (data?.teams || []).forEach(t => {
            delete t.valuesByStat;
            delete t.record;
            delete t.points;
            delete t.pointsAdjusted;
        });
        // THE FIXTURES SURVIVE, THE RESULTS DO NOT. season-state.js keeps a second witness for head-to-head formats - a game with a decided winner is play by definition - so a rewind that only emptied the teams would still read as underway, and did. A preseason league really does carry its whole schedule with every game undecided and no score on it.
        (data?.schedule || []).forEach(g => {
            g.winner = 'UNDECIDED';
            ['home', 'away'].forEach(side => {
                const s = g[side];
                if (!s) return;
                delete s.cumulativeScore;
                delete s.pointsByScoringPeriod;
                delete s.totalPoints;
                // The roster on each side stays: it is the squad the team actually holds, which is what the faces are built to read.
            });
        });
        return data;
    };

    const payloadPromise = held(payloadDelayMs, () => (captureDir ? composeCapture() : fetchJson(payloadFile)))
        .then(data => {
            if (data) return data;
            // S10: a capture dir that 404s (most often the JSON_debug/ prefix left off a bare ?capture= name) used to fall back to the sample league SILENTLY - a shot of the sample staged as if it were the real fixture, caught only by someone reading team names in the frame. Loud now: whichever request failed, named, before the fallback. THE SAMPLE ITSELF FAILING IS A DIFFERENT SENTENCE. Now that it is also the default, "could not load the payload X - falling back to X" is a message this branch can reach, and a reader told to fall back to the file that just failed learns nothing.
            if (!captureDir && payloadFile === SAMPLE_FILE) {
                console.error(`browser-stub: could not load ${SAMPLE_FILE}. Serve this page from the repository root - it is fetched by a path relative to the page.`);
                return null;
            }
            const missed = captureDir ? `capture dir "${captureDir}" (team.json/roster.json/draft-detail.json)` : `payload "${payloadFile}"`;
            console.error(`browser-stub: could not load the ${missed} - falling back to ${SAMPLE_FILE}. A bare ?capture= name needs the JSON_debug/ prefix (?capture=JSON_debug/<dir>).`);
            return fetchJson(SAMPLE_FILE);
        })
        .then(data => (data && asPreseason) ? rewindToPreseason(data) : data)
        .then(data => (data && anonymize) ? anonymizePayload(data) : data);

    // kona_player_info interception, two cases told apart by the scoring-period filter header: - The pool request is served from the captured ?players= file when one is given, and passes through otherwise (its failure is the tab's own already-handled error state). - Weekly-stats requests are answered with an empty-but-valid pool. A static page can never complete them for real (they need ESPN cookie auth), and letting them fail put two red fetch errors in the console on EVERY dev-preview load (the leaderboard warm-up in players.js prefetchPlayerData fires them unprompted), burying real errors during verification. The empty success means the app caches empty per-player weekly stubs, so offline a WINDOWED timeframe computes empty aggregates instead of showing the bulk- fetch error state - the honest trade was console noise on every load vs a degraded state only on a view the offline harness can't support anyway; the info line below is the breadcrumb for anyone testing windowed timeframes offline. A fresh Response per call, since a Response body can only be consumed once and the bulk fetch is chunked.
    const playersName = params.get('players');
    const playersFile = playersName
        ? (playersName.includes('/') ? playersName : `JSON_debug/${playersName}`)
        : (captureDir ? captureFile('player-pool.json') : null);

    const scoreboardName = params.get('scoreboard');
    const scoreboardFile = scoreboardName && (scoreboardName.includes('/') ? scoreboardName : `JSON_debug/${scoreboardName}`);
    // year -> captured payload file, e.g. ?seasons=2024:hockey-roto-2024-league.json,2025:...
    const seasonsArg = params.get('seasons');
    const seasonFiles = new Map();
    (seasonsArg ? seasonsArg.split(',') : []).forEach(pair => {
        const [y, f] = pair.split(':');
        if (y && f) seasonFiles.set(String(y).trim(), f.includes('/') ? f.trim() : `JSON_debug/${f.trim()}`);
    });

    // year -> captured PLAYER POOL file, e.g. ?seasonpools=2024:hockey-roto-2024-pool.json,2025:... Separate from ?players= because they answer different questions of the same endpoint: that one is the pool Player Metrics reads, this one is what a career sums. They overlap on the live season and are still not the same request - the career fetch drops projections.
    const poolsArg = params.get('seasonpools');
    const poolFiles = new Map();
    (poolsArg ? poolsArg.split(',') : []).forEach(pair => {
        const [y, f] = pair.split(':');
        if (y && f) poolFiles.set(String(y).trim(), f.includes('/') ? f.trim() : `JSON_debug/${f.trim()}`);
    });

    const historyOmit = new Set((params.get('historyomit') || '').split(',').map(s => s.trim()).filter(Boolean));

    const proteamName = params.get('proteam');
    const proteamFile = proteamName && (proteamName.includes('/') ? proteamName : `JSON_debug/${proteamName}`);
    // &proteamDelay=<ms> holds the schedule back the way the real fetch does. Served instantly, the Schedule face exists before the tab is ever entered and the re-fit that arriving starts triggers can never land while that face is on screen - which is the one moment the fit is decided against a layout the other face has to live with too.
    const proteamDelayMs = delayMs('proteamDelay');

    // ?weekly=<file>&weeklyDelay=<ms> - the weekly-loading harness. Without it, weekly requests answer with an empty pool (see the note below), which is enough for "does the page survive offline" but can't exercise anything about HOW the weekly data arrives. With it, the stub indexes a real captured bulk weekly payload by player id and answers each chunk request with exactly the ids that request asked for, after an artificial per-chunk delay - so chunk ORDER, progressive pop-in, scroll/sort reprioritization, and a drill-down jumping the queue are all observable and deterministic offline. Every served chunk is appended to window.__stubWeeklyChunks ({at, count, ids}) as the record to assert ordering against. ?weekly=<file>[,<file>...] - SEVERAL FILES MERGE INTO ONE INDEX, which is what makes a single-player drill-down capture usable here. Those captures are the drill-down fetch's own response and already carry the shape this harness indexes - { players: [entry] } keyed by player id - so a comma-separated list needs no second parameter and no second code path: the bulk chunk request and the one-player request are answered out of the same map. Naming a player twice is harmless; the later file wins, which is what a fresher capture should do.
    const weeklyName = params.get('weekly');
    const weeklyFiles = weeklyName
        ? weeklyName.split(',').map(n => n.trim()).filter(Boolean)
            .map(n => (n.includes('/') ? n : `JSON_debug/${n}`))
        : [];
    const weeklyDelayMs = Number(params.get('weeklyDelay') || 250);
    window.__stubWeeklyChunks = [];
    // Parsed once and shared. These captures run to tens of MB, so re-reading per chunk would dwarf the very latency the harness is trying to simulate.
    const weeklyIndexPromise = weeklyFiles.length
        ? Promise.all(weeklyFiles.map(fetchJson)).then(datas => {
            const index = new Map();
            datas.forEach(data => (data?.players || []).forEach(entry => {
                const id = entry?.id ?? entry?.player?.id;
                if (id != null) index.set(Number(id), entry);
            }));
            console.info(`browser-stub: weekly harness ready: ${index.size} players indexed from ${weeklyFiles.length} file(s), ${weeklyDelayMs}ms per chunk.`);
            return index;
        })
        : null;

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

    // &txDelay=<ms> - holds every transaction and draft request that long, which is the only way to measure a harvest here at all: the fixture answers off disk in under a millisecond, so a change that reorders ~400 requests reads as noise without a modelled network. ?txstatus=<code>&txokfirst=<n> - THE REFUSAL HARNESS. The first n period requests are answered normally and every one after is refused with that status, which is the shape a walk meets when a host starts saying no partway through: 429 for a throttle, 401 for a session that expired mid-harvest. Without it a circuit breaker can only be reasoned about, and the thing being tested is precisely what happens AFTER the refusal starts - a count of requests not made, which needs a run that would otherwise have made them. 429 carries no Retry-After on purpose: throttleOf treats a bare 429 as a 30s throttle, and that is the branch worth staging, since a Retry-After makes the queue's own gate the actor.
    const txStatus = Number(params.get('txstatus')) || 0;
    const txOkFirst = Number(params.get('txokfirst') || 0);
    async function serveTransactionPeriod(url) {
        const byPeriod = await txPromise;
        const m = /[?&]scoringPeriodId=(\d+)/.exec(url);
        const period = m ? Number(m[1]) : null;
        const transactions = (period != null && byPeriod.get(period)) || [];
        window.__stubTransactionPeriods = (window.__stubTransactionPeriods || 0) + 1;
        if (txStatus && window.__stubTransactionPeriods > txOkFirst) {
            return new Response('', { status: txStatus, statusText: 'Stubbed refusal' });
        }
        await new Promise(resolve => setTimeout(resolve, delayMs('txDelay')));
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

    // THE POOL HALF OF THE REWIND. rewindToPreseason above empties the LEAGUE payload and for a long time that was the whole of ?preseason=1 - which staged a league that cannot exist: nobody has played, and every player carries a full season of statistics. Measured on full-nfl, whose pool profiles (source,split) (0,0):1091 - a completed 2025 actual line on all 1,091 players - so the Player Metrics leaderboard ranked a "preseason" league on a finished one and looked entirely credible doing it. WHAT GOES, AND ONLY THIS: the CURRENT season's ACTUAL line (statSourceId 0, statSplitTypeId 0, seasonId equal to the league's). That is the line a league genuinely does not have the week before it starts. WHAT STAYS: the projections (source 1), which are the whole point of a preseason face, and every PRIOR season's line, which estimateUnprojected reads to fill a category ESPN does not forecast. Stripping those would break the estimator and make the rewind a different lie. Parsed once and memoised: the pool is 3.7MB on the football capture and 15MB on the baseball one, and the careers table asks for one per season.
    let rewoundPool = null;
    const rewindPoolIfPreseason = async (response) => {
        if (!asPreseason) return response;
        if (!rewoundPool) {
            rewoundPool = (async () => {
                const payload = await payloadPromise;
                const season = payload && payload.seasonId;
                const data = await response.clone().json();
                let stripped = 0;
                (data.players || []).forEach(entry => {
                    const player = entry.player;
                    if (!player || !Array.isArray(player.stats)) return;
                    const before = player.stats.length;
                    player.stats = player.stats.filter(st => !(st.statSourceId === 0
                        && st.statSplitTypeId === 0 && st.seasonId === season));
                    stripped += before - player.stats.length;
                });
                console.info(`browser-stub: preseason pool rewind removed ${stripped} actual ${season} season lines from ${(data.players || []).length} players.`);
                return JSON.stringify(data);
            })();
        }
        const body = await rewoundPool;
        return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    };

    // ?fresh=<file>&freshDelay=<ms> - the REVALIDATE harness. dev-preview always takes the restore path (the fake session storage always answers with the payload), so the background revalidate always fires here; without this it fails against the real host and the cached view stays put, which is itself the "failed revalidate" case worth testing. Given a file, the league request is answered with it instead, after freshDelay - so the cached paint and the fresh one are separated by a visible gap and can be told apart by a changed figure. Counted, so a test can assert the request happened exactly once.
    const freshName = params.get('fresh');
    const freshFile = freshName && (freshName.includes('/') ? freshName : `JSON_debug/${freshName}`);
    const freshPromise = freshFile ? fetchJson(freshFile).then(d => (d && anonymize) ? anonymizePayload(d) : d) : null;
    window.__stubLeagueRequests = 0;
    // Every URL the app asked for, in order, with the cache mode it asked with. The cache-busting acceptance is a statement about URLS - that two live reads of the same endpoint never carry the same query, and that a historical read is byte-identical every time - so the harness has to remember the strings rather than just the count.
    window.__stubSeenUrls = [];

    const realFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('espn.com')) {
            // The CALLER, not just the url. The tally in utils.js can say what kind a request was and which host it went to; it cannot say what made it happen, and "what triggered this" is the whole question an efficiency review has to answer. The stack is trimmed to the app's own frames so a bucket reads as a call path rather than as noise.
            let via = '';
            try {
                via = (new Error().stack || '').split(String.fromCharCode(10))
                    .map(l => (l.match(/at ([A-Za-z0-9_$.<>]+)\s/) || [])[1] || '')
                    .filter(f => f && !/^(fetch|Object|Promise|window)/.test(f))
                    .slice(1, 5).join(' < ');
            } catch (e) { /* stacks are best effort */ }
            // The FILTER'S OWN KEYS, because a weekly-stats request and a plain pool request are the SAME URL - api.js's requestKindOf tells them apart by looking inside X-Fantasy-Filter, and a reader with only the url cannot. Recording the keys rather than the whole filter keeps this small (filterIds carries 75 player ids) and leaves the RULE to the reader, which is where it belongs. Without this a request tally counts the race's weekly harvest as pool reads, which is exactly the misreading it exists to prevent.
            let filterKeys = [];
            try {
                const raw = options && options.headers && options.headers['X-Fantasy-Filter'];
                if (raw) filterKeys = Object.keys((JSON.parse(raw) || {}).players || {});
            } catch (e) { /* a filter we cannot parse is one we say nothing about */ }
            window.__stubSeenUrls.push({ url: u, cache: options && options.cache, via, filterKeys });
        }
        if (u.includes('/segments/0/leagues/') && !u.includes('/leagueHistory/') && u.includes('view=mTeam')) {
            window.__stubLeagueRequests += 1;
            if (freshPromise) {
                return held(delayMs('freshDelay'), () => freshPromise)
                    .then(d => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }));
            }
        }
        if (draftPromise && u.includes('view=mDraftDetail')) {
            window.__stubDraftRequests = (window.__stubDraftRequests || 0) + 1;
            return draftPromise
                .then(d => new Promise(resolve => setTimeout(() => resolve(d), delayMs('txDelay'))))
                .then(d => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }));
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
        // leagueHistory: answer with the years the harness was given, so discovery matches what can actually be served.
        if (seasonFiles.size && u.includes('/leagueHistory/')) {
            const years = [...seasonFiles.keys()]
                .filter(y => !historyOmit.has(String(y)))
                .map(y => ({ seasonId: Number(y) }));
            return Promise.resolve(new Response(JSON.stringify(years), { headers: { 'Content-Type': 'application/json' } }));
        }
        // A past season's league payload.
        if (seasonFiles.size) {
            const m = u.match(/\/seasons\/(\d{4})\//);
            if (m && seasonFiles.has(m[1]) && u.includes('view=mTeam')) {
                return realFetch(seasonFiles.get(m[1]));
            }
        }
        if (proteamFile && u.includes('proTeamSchedules_wl')) {
            return held(proteamDelayMs, () => realFetch(proteamFile));
        }
        // The draft's own view. Without it the graded card can only say the picks are missing, which is the honest empty state but not the one worth staging.
        if (captureDir && typeof url === 'string' && url.includes('mDraftDetail')) {
            return realFetch(captureFile('draft-detail.json'));
        }
        // The pro clubs' own season. Every schedule-derived lens - playoff density, off nights, two- start pitchers, games left - is null without it, so a capture that omitted it could stage only the empty states of the features that most need staging.
        if (captureDir && typeof url === 'string' && url.includes('proTeamSchedules')) {
            return realFetch(captureFile('pro-schedule.json'));
        }
        // A PAYLOAD THAT CARRIES ITS OWN DRAFT answers for it. The app fetches mDraftDetail through a separate view, so a fixture with picks in it would otherwise be asked for them over the network and get nothing - the graded card stuck on "reading the draft" beside a file that holds the very picks it is waiting for. Only the fixture's own draft is served, never invented, and a payload without one still answers empty.
        if (!captureDir && u.includes('mDraftDetail')) {
            return payloadPromise.then(p => new Response(
                JSON.stringify({ draftDetail: (p && p.draftDetail) || {} }),
                { headers: { 'Content-Type': 'application/json' } }));
        }
        const isKona = typeof url === 'string' && url.includes('kona_player_info');
        if (!isKona) return realFetch(url, options);
        const filterHeader = options?.headers?.['X-Fantasy-Filter'] || '';
        if (filterHeader.includes('filterStatsForTopScoringPeriodIds')) {
            if (weeklyFiles.length) return serveWeeklyChunk(filterHeader);
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
        const servePool = () => (playersFile
            ? held(playersDelayMs, () => realFetch(playersFile).then(rewindPoolIfPreseason))
            : realFetch(url, options).then(rewindPoolIfPreseason));
        // One season's pool, which the career table asks for a year at a time. Matched on the year in the path, and checked here rather than earlier so the weekly branch above still owns its own requests. A season with no file of its own is REFUSED, not left to fall through. It used to fall through to ?players=, so a run staging pools for two of three seasons quietly served the current season's players as the third one's, and the career table came back with 220 rows where the data supports 183 - a harness agreeing with itself and with nothing real. A refusal is also what a season ESPN will not serve actually looks like.
        if (poolFiles.size) {
            const m = u.match(/\/seasons\/(\d{4})\//);
            if (m && poolFiles.has(m[1])) return held(delayMs('seasonPoolDelay'), () => realFetch(poolFiles.get(m[1])));
            if (m) {
                return payloadPromise.then(p => ((!p || String(p.seasonId) === m[1])
                    ? servePool()
                    : new Response('', { status: 404, statusText: 'No pool staged' })));
            }
        }
        return servePool();
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
            // A REAL KEY-VALUE STORE, not a fixed answer. This used to return { sport, leagueId, year } for EVERY key asked for and drop every write on the floor, which was enough while the only reader was the league selector and is not enough for anything that stores something and reads it back later. The preseason snapshot could not be staged at all against it: the write path fired and stored nothing, and the read path could only ever answer null. Seeded with the same derived triple, so the selector behaves exactly as it did.
            local: (() => {
                let store = null;
                // Sport and year are derived from the loaded payload (gameId: 2 = baseball/flb, 4 = hockey/fhl; seasonId is the year) so any capture loads with the right stat maps and the right season - processPlayerData matches player stat lines by seasonId === year, so a hardcoded year would leave every player with empty season totals whenever the payload is from a different season. Falls back to flb.
                const seeded = async () => {
                    if (store) return store;
                    store = {};
                    if (noLeague) return store;
                    const apiData = await payloadPromise;
                    store.sport = apiData?.gameId === 4 ? 'fhl' : 'flb';
                    store.leagueId = 'dev-preview';
                    store.year = String(apiData?.seasonId || '2025');
                    return store;
                };
                // The real API's shapes: null or undefined asks for everything, a string for one key, an array for several. An absent key is missing from the answer, which is what every caller here already handles.
                const pick = (all, keys) => {
                    if (keys === null || keys === undefined) return { ...all };
                    const list = Array.isArray(keys) ? keys : [keys];
                    const out = {};
                    list.forEach(k => { if (k in all) out[k] = all[k]; });
                    return out;
                };
                return {
                    get: async (keys) => pick(await seeded(), keys),
                    set: async (obj) => { Object.assign(await seeded(), obj || {}); },
                    remove: async (keys) => {
                        const all = await seeded();
                        (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete all[k]; });
                    }
                };
            })(),
            session: {
                get: async () => {
                    if (noLeague) return {};
                    const apiData = await payloadPromise;
                    if (!apiData) {
                        console.error(`browser-stub: couldn't load payload "${payloadFile}"`);
                        return {};
                    }
                    // The real fetch fills this from the leagueHistory endpoint; dev-preview restores from the session cache and never runs that call, so ?seasons= seeds it here or League History would only ever see the loaded season.
                    return { apiData, leagueHistoryYears: [...seasonFiles.keys()].map(Number) };
                },
                set: async () => {}
            }
        },
        // RECORDED, not swallowed. main.js redirects a popup to a full tab through this call, and whether it fires is the single fact that separates a working popup from the sliver - so the harness needs to see it happen. Still a no-op otherwise, because the harness is a tab.
        tabs: { create: async (arg) => { (window.__stubTabsCreated = window.__stubTabsCreated || []).push(arg); } },
        // Always granted, so the dev flow never sees the Firefox opt-in prompt checkAuth renders for a store install (see hasEspnHostAccess in api.js). request() is here for shape only: nothing in dev-preview can reach it while contains() answers true.
        permissions: {
            contains: async () => true,
            request: async () => true
        },
        runtime: { getURL: (p) => p }
    };
})();
