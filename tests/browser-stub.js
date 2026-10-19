// Dev-only stand-in for the WebExtension browser API, used by dev-preview.html on a static server with a captured league payload preloaded as the session cache. Query switches choose the payload and stage states (anonymized names, preseason, rosters, delays, refusals), and each is explained beside the code that reads it.
(function () {
    if (window.browser) return;

    const params = new URLSearchParams(location.search);
    // A capture is one moment, so a cell that depends on the day is staged at the capture's own time rather than at the day the preview is opened. The clock starts at the given instant and runs on, which keeps every elapsed duration real.
    const pinnedNow = Date.parse(params.get('now') || '');
    if (Number.isFinite(pinnedNow)) {
        const RealDate = Date;
        const offset = pinnedNow - RealDate.now();
        class PreviewDate extends RealDate {
            constructor(...args) {
                if (args.length) super(...args);
                else super(RealDate.now() + offset);
            }
            static now() { return RealDate.now() + offset; }
        }
        window.Date = PreviewDate;
    }
    // The bundled anonymized sample league. It is declared here rather than beside its fetch because it is the default, not only the fallback (see payloadFile just below).
    const SAMPLE_FILE = 'tests/sample-league.json';
    // Asking for nothing loads the bundled sample league, not a capture that may not exist. The loud error is kept for a capture that was named and failed to load, so a clone that asked for nothing never logs a 404 for a private directory.
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
    // Flips the fake session to logged in and pokes the same watcher a real login would, so the recovery runs through the real path rather than a hand-fired event. Clears ?poolstatus too, since a login that leaves the pool refused is not a login.
    window.__stubLogIn = () => {
        window.__stubLoggedOut = false;
        window.__stubPoolStatusCleared = true;
        window.dispatchEvent(new Event('focus'));
    };

    // Invented team names in the register a real league writes in, each with its own abbreviation, so anonymized screenshots do not read as broken placeholders. The list wraps with a numeric suffix so a larger league never collides.
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
    // One league out of four files: the capture directory holds what four ESPN views returned, so they are put back together here as the app's own fetches do, with the rosters riding the team in mRoster and the picks living in mDraftDetail.
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

    // The preseason rewind works by subtraction, never by a flag: a league is in preseason when nobody has posted a stat line, so removing them reproduces the real payload of the week before the season. season-state.js reads it and answers for itself, so nothing here can leak into the product.
    const rewindToPreseason = (data) => {
        (data?.teams || []).forEach(t => {
            delete t.valuesByStat;
            delete t.record;
            delete t.points;
            delete t.pointsAdjusted;
        });
        // The fixtures survive, the results do not. season-state.js keeps a second witness for head-to-head formats (a decided game is play by definition), so a rewind that only emptied the teams would still read as underway. A preseason league carries its whole schedule with every game undecided and no score.
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
            // A capture directory that fails to load is reported by name before the fallback, so a screenshot of the sample is never staged as if it were the real fixture. If the sample itself is what failed, the message says so instead of naming the file as its own fallback.
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

    // The player pool request is served from the captured players file when one is given and passes through otherwise. Weekly-stats requests, told apart by the scoring-period filter header, get an empty but valid pool, since a static page cannot complete them and failing them would bury real errors in the console. A fresh Response is built per call because a body is consumed once.
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

    // Year to captured player pool file, e.g. ?seasonpools=2024:hockey-roto-2024-pool.json,2025:... It is separate from ?players= because the two answer different requests of the same endpoint: that one is the pool Player Metrics reads, this one is what a career sums. They overlap on the live season, and the career fetch drops projections.
    const poolsArg = params.get('seasonpools');
    const poolFiles = new Map();
    (poolsArg ? poolsArg.split(',') : []).forEach(pair => {
        const [y, f] = pair.split(':');
        if (y && f) poolFiles.set(String(y).trim(), f.includes('/') ? f.trim() : `JSON_debug/${f.trim()}`);
    });

    const historyOmit = new Set((params.get('historyomit') || '').split(',').map(s => s.trim()).filter(Boolean));

    const proteamName = params.get('proteam');
    const proteamFile = proteamName && (proteamName.includes('/') ? proteamName : `JSON_debug/${proteamName}`);
    // &proteamDelay=<ms> holds the schedule back the way the real fetch does. Served instantly, the Schedule face exists before the tab is entered and the re-fit that the arrival triggers can never land while that face is on screen, which is the one moment the fit is decided against a layout the other face has to live with too.
    const proteamDelayMs = delayMs('proteamDelay');

    // ?weekly=<file>&weeklyDelay=<ms> replays a captured bulk weekly payload indexed by player id, answering each chunk request with exactly the ids asked for after a per-chunk delay, and records every served chunk in window.__stubWeeklyChunks. Several files merge into one index, the later file winning, so single-player drill-down captures work too.
    const weeklyName = params.get('weekly');
    const weeklyFiles = weeklyName
        ? weeklyName.split(',').map(n => n.trim()).filter(Boolean)
            .map(n => (n.includes('/') ? n : `JSON_debug/${n}`))
        : [];
    const weeklyDelayMs = Number(params.get('weeklyDelay') || 250);
    window.__stubWeeklyChunks = [];
    // ?capture=<dir> also offers its own player-weekly.json when no ?weekly= is given, the explicit parameter winning, so one capture query stages the whole roto race. A capture without that file answers with the empty pool and its once-per-page note.
    const captureWeekly = !weeklyFiles.length && captureDir ? captureFile('player-weekly.json') : null;
    const indexWeekly = (datas, label) => {
        const index = new Map();
        datas.forEach(data => (data?.players || []).forEach(entry => {
            const id = entry?.id ?? entry?.player?.id;
            if (id != null) index.set(Number(id), entry);
        }));
        console.info(`browser-stub: weekly harness ready: ${index.size} players indexed from ${label}, ${weeklyDelayMs}ms per chunk.`);
        return index;
    };
    // Parsed once and shared. These captures run to tens of MB, so re-reading per chunk would dwarf the very latency the harness is trying to simulate. NULL means NOT SERVING.
    const weeklyIndexPromise = weeklyFiles.length
        ? Promise.all(weeklyFiles.map(fetchJson)).then(datas => {
            // A named file that did not load is reported as missing, never counted as zero players, which was the silent zero the roster harness used to give a file in the wrong shape.
            datas.forEach((data, i) => {
                if (data === null) console.error(`browser-stub: could not load the weekly file ${weeklyFiles[i]} - it adds no players.`);
            });
            return indexWeekly(datas, weeklyFiles.join(', '));
        })
        : captureWeekly
            ? fetchJson(captureWeekly).then(data => {
                if (data === null) {
                    console.info(`browser-stub: no player-weekly.json in ${captureDir} - weekly stats answer with the empty pool as before.`);
                    return null;
                }
                return indexWeekly([data], captureWeekly);
            })
            : null;

    // The empty pool is the answer when nothing replays the weekly stats. It is one function because a stub with no ?weekly= and a capture with no player-weekly.json must answer identically.
    function emptyWeeklyResponse() {
        // Window-scoped once-flag (not a closure let) so the note prints once per page no matter how many chunked requests, or stub instances, ever run.
        if (!window.__stubWeeklyNoted) {
            window.__stubWeeklyNoted = true;
            console.info('browser-stub: weekly player stats are unavailable offline. This serves an empty pool, so the leaderboard falls back to season totals and windowed timeframes stay empty. Pass ?weekly=<file> to replay a captured bulk payload instead.');
        }
        return new Response('{"players": []}', { headers: { 'Content-Type': 'application/json' } });
    }

    async function serveWeeklyChunk(filterHeader) {
        const index = await weeklyIndexPromise;
        // A capture with no player-weekly.json: answered exactly as a stub with no ?weekly= always was.
        if (index === null) return emptyWeeklyResponse();
        let ids = [];
        try { ids = JSON.parse(filterHeader)?.players?.filterIds?.value || []; } catch { /* unparseable filter - serve empty */ }
        const players = ids.map(id => index.get(Number(id))).filter(Boolean);
        await new Promise(resolve => setTimeout(resolve, weeklyDelayMs));
        window.__stubWeeklyChunks.push({ at: Math.round(performance.now()), count: ids.length, ids: ids.slice() });
        return new Response(JSON.stringify({ players }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ?draft=<file>&transactions=<file> answers the draft request with the draft file and each per-period transaction request with the merged fixture filtered to that period, as the real harvest sees it. Without them the requests fall through to the network and the race stays on its current-roster fallback.
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

    // ?txDelay=<ms> holds every transaction and draft request that long, since the fixture answers off disk too fast to measure a harvest. ?txstatus=<code>&txokfirst=<n> answers the first n period requests normally and refuses the rest with that status, the shape of a host that starts saying no partway through a walk. A bare 429 is used on purpose because it stages the 30 second throttle branch.
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

    // ?rosters=<file> answers each per-period roster request from the distilled snapshot fixture, rebuilt into ESPN's raw mRoster shape so the real parser runs against it. Two shapes are accepted, the wrapped { days } form and the bare form Download All writes, detected by roster-timeline.js's rosterDaysOf. An explicit ?rosters= wins, otherwise ?capture=<dir> offers its own roster-days.json.
    const rostersName = params.get('rosters');
    const explicitRosters = rostersName && (rostersName.includes('/') ? rostersName : `JSON_debug/${rostersName}`);
    const rostersFile = explicitRosters || (captureDir ? captureFile('roster-days.json') : null);

    // Null means not serving, so the harvest's requests fall through to the network. An object, even an empty one, means this harness answers every period from it.
    async function loadRosterDays(file, explicit) {
        const data = await fetchJson(file);
        if (data === null) {
            if (explicit) {
                console.error(`browser-stub: could not load the roster snapshot file ${file} - answering the harvest with ZERO snapshots.`);
                return {};
            }
            console.info(`browser-stub: no roster-days.json in ${captureDir} - the roster harvest falls through to the network as before.`);
            return null;
        }
        // A literal specifier, as room-feed.js's below: the parse belt and the coverage gate both follow it.
        const { rosterDaysOf } = await import('../src/engines/roster-timeline.js');
        const { days, shape } = rosterDaysOf(data);
        window.__stubRosterShape = shape;
        window.__stubRosterPeriods = 0;
        if (shape === 'unrecognised') {
            console.error(`browser-stub: ${file} is neither roster-days shape - not { days: { N: [...] } } and not { N: [...] } - so ZERO snapshots were loaded from it.`);
            return explicit ? {} : null;
        }
        // A UNIFORM FILE IS SAID TO BE ONE, measured rather than recognised by name: the generated fixture carries the SAME snapshot on every day, and a race drawn from it is a league where nobody ever moved. Fine for layout; never for attribution (make-roster-days.ps1's own first warning).
        const periods = Object.keys(days);
        const first = periods.length ? JSON.stringify(days[periods[0]]) : null;
        const uniform = periods.length > 1 && periods.every(k => JSON.stringify(days[k]) === first);
        window.__stubRosterUniform = uniform;
        console.info(`browser-stub: roster snapshot harness ready: ${periods.length} daily snapshots from ${file} (${shape})`
            + (uniform ? ' - EVERY DAY IDENTICAL: layout proofs only, never attribution.' : '.'));
        return days;
    }
    const rostersPromise = rostersFile ? loadRosterDays(rostersFile, !!explicitRosters) : null;

    async function serveRosterPeriod(url, options) {
        const days = await rostersPromise;
        // A capture with no roster-days.json: not this harness's request after all.
        if (days === null) return realFetch(url, options);
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

    // The pool half of the rewind: it removes the current season's actual line (source 0, split 0, the league's own season) from every player, since a preseason league has none. Projections and prior seasons' lines stay, because the preseason faces and estimateUnprojected read them. The pool is parsed once and memoised, as it is 3.7MB for football and 15MB for baseball.
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

    // ?fresh=<file>&freshDelay=<ms> answers the background revalidate with that file after the delay, so the cached paint and the fresh one are separated by a visible gap and told apart by a changed figure. Without it the revalidate fails against the real host and the cached view stays, which is the failed-revalidate case. The requests are counted so a test can assert exactly one.
    const freshName = params.get('fresh');
    const freshFile = freshName && (freshName.includes('/') ? freshName : `JSON_debug/${freshName}`);
    const freshPromise = freshFile ? fetchJson(freshFile).then(d => (d && anonymize) ? anonymizePayload(d) : d) : null;
    window.__stubLeagueRequests = 0;
    // Every URL the app asked for, in order, with the cache mode it asked with. The cache-busting check is about URLs, that two live reads of the same endpoint never share a query and a historical read is identical every time, so the strings are kept rather than a count.
    window.__stubSeenUrls = [];

    const realFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
        const u = typeof url === 'string' ? url : '';
        // The whole host, not a substring: "espn.com" can sit anywhere in a string.
        let host = '';
        try { host = new URL(u).hostname.toLowerCase(); } catch (e) { host = ''; }
        if (host === 'espn.com' || host.endsWith('.espn.com')) {
            // The caller, not just the url. The tally in utils.js says what kind of request it was and which host it went to but not what triggered it, which is the question an efficiency review has to answer. The stack is trimmed to the app's own frames so a bucket reads as a call path rather than as noise.
            let via = '';
            try {
                via = (new Error().stack || '').split(String.fromCharCode(10))
                    .map(l => (l.match(/at ([A-Za-z0-9_$.<>]+)\s/) || [])[1] || '')
                    .filter(f => f && !/^(fetch|Object|Promise|window)/.test(f))
                    .slice(1, 5).join(' < ');
            } catch (e) { /* stacks are best effort */ }
            // The filter's own keys are recorded because a weekly-stats request and a plain pool request share one URL, and api.js's requestKindOf tells them apart by looking inside X-Fantasy-Filter. Keys rather than the whole filter keep the record small, and the rule stays with the reader.
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
            return serveRosterPeriod(u, options);
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
        // The pro clubs' own season. Every schedule-derived lens (playoff density, off nights, two-start pitchers, games left) is null without it, so a capture that omitted it could stage only the empty states of the features that most need staging.
        if (captureDir && typeof url === 'string' && url.includes('proTeamSchedules')) {
            return realFetch(captureFile('pro-schedule.json'));
        }
        // A payload that carries its own draft answers for it. The app fetches mDraftDetail through a separate view, so a fixture with picks would otherwise be asked for them over the network and get nothing, leaving the graded card stuck on reading the draft. Only the fixture's own draft is served, never invented, and a payload without one still answers empty.
        if (!captureDir && u.includes('mDraftDetail')) {
            return payloadPromise.then(p => new Response(
                JSON.stringify({ draftDetail: (p && p.draftDetail) || {} }),
                { headers: { 'Content-Type': 'application/json' } }));
        }
        const isKona = typeof url === 'string' && url.includes('kona_player_info');
        if (!isKona) return realFetch(url, options);
        const filterHeader = options?.headers?.['X-Fantasy-Filter'] || '';
        if (filterHeader.includes('filterStatsForTopScoringPeriodIds')) {
            if (weeklyIndexPromise) return serveWeeklyChunk(filterHeader);
            return Promise.resolve(emptyWeeklyResponse());
        }
        // ?poolstatus=<code> refuses only the pool request with that status, which is what a logged-out ESPN session looks like. The league read still succeeds and the filtered pool is turned away with 405 rather than 401. Without it the state can be described but not reproduced.
        if (poolStatus && !window.__stubPoolStatusCleared) {
            return Promise.resolve(new Response('', { status: poolStatus, statusText: 'Stubbed' }));
        }
        const servePool = () => (playersFile
            ? held(playersDelayMs, () => realFetch(playersFile).then(rewindPoolIfPreseason))
            : realFetch(url, options).then(rewindPoolIfPreseason));
        // One season's pool, which the career table asks for a year at a time, matched on the year in the path after the weekly branch has had its turn. A season with no file of its own is refused rather than falling through to ?players=, which once served the current season's players as another season's and let the career table agree with itself and nothing real.
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

    // ?room=<fixture>, below, is the harness half of the draft room feed. This is declared outside that block because runtime.onMessage.addListener registers into roomListeners before the replay's async chain has resolved, and a listener array only the replay closure could see would miss every registration that beat it there.
    const roomListeners = [];
    let roomSendMessageHandler = null;

    window.browser = {
        cookies: {
            // Fake cookies so checkAuth passes and the dashboard renders clean; the league picker's fan-profile fetch fails harmlessly because it is already best-effort. SWID is derived from whichever payload is loaded (the first team's own primaryOwner), not hardcoded, so My Team auto-detection (recap.js detectMyTeamId) has a real match against any payload passed via ?payload=.
            get: async ({ name }) => {
                // ?nocookies=1 starts the page logged OUT. window.__stubLogIn() then flips it, which is the only way to exercise the mid-session login recovery. The real trigger is checkAuth going green, and it can only go green if it was red first.
                if (window.__stubLoggedOut) return null;
                const apiData = await payloadPromise;
                const owner = apiData?.teams?.find(t => t.primaryOwner)?.primaryOwner;
                return { name, value: owner || '' };
            }
        },
        storage: {
            // A real key-value store rather than a fixed answer: it used to return the same triple for every key and drop every write, which was enough while only the league selector read it. Anything that stores a value and reads it back, such as the preseason snapshot, needs writes that stick. It is seeded with the same derived triple so the selector behaves as before.
            local: (() => {
                let store = null;
                // Sport and year are derived from the loaded payload (gameId 2 is baseball/flb, 4 is hockey/fhl; seasonId is the year) so any capture loads with the right stat maps and season. processPlayerData matches player stat lines by seasonId === year, so a hardcoded year would leave every player with empty season totals whenever the payload is from a different season. Falls back to flb.
                const seeded = async () => {
                    if (store) return store;
                    store = {};
                    if (noLeague) return store;
                    const apiData = await payloadPromise;
                    store.sport = apiData?.gameId === 4 ? 'fhl' : 'flb';
                    store.leagueId = 'dev-preview';
                    store.year = String(apiData?.seasonId || '2025');
                    // ?nicknames=<teamId>:<name>,... seeds api.js's nicknames storage key before the page asks for it, since this stub has no keyboard to type into the sheet. It is keyed by the stub's own 'dev-preview' league id rather than the payload's numeric id, because the app builds that key from the #league-id input, which loadStoredSettings fills from this stub's storage.
                    if (params.get('nicknames')) {
                        const obj = {};
                        params.get('nicknames').split(',').forEach(pair => {
                            const at = pair.indexOf(':');
                            if (at === -1) return;
                            const teamId = pair.slice(0, at);
                            const name = decodeURIComponent(pair.slice(at + 1));
                            if (teamId && name) obj[teamId] = name;
                        });
                        if (Object.keys(obj).length) store[`nicknames:${store.sport}:${store.leagueId}`] = obj;
                    }
                    // ?snapshot=1 seeds the preseason snapshot the app itself would have written, under the app's own key, which uses AppState.loadedSport and the payload's league id rather than the 'dev-preview' selector id. takenInState is 'post-draft-preseason', one of the two isPreseasonSnapshot accepts, and the lines are the capture's own projected totals so the frozen board ranks its pool.
                    if (params.get('snapshot') === '1') {
                        const sport = { 1: 'ffl', 2: 'flb', 4: 'fhl' }[apiData?.gameId] || store.sport;
                        const players = {};
                        if (playersFile) {
                            const pool = await fetchJson(playersFile);
                            const list = Array.isArray(pool) ? pool : (pool?.players || []);
                            list.forEach(entry => {
                                const player = entry?.player || entry;
                                if (!player || player.id === undefined || player.id === null) return;
                                const line = (player.stats || []).find(st => st && st.statSourceId === 1 && st.statSplitTypeId === 0);
                                if (line && line.stats) players[String(player.id)] = { ...line.stats };
                            });
                        }
                        store[`preseason:${sport}:${apiData?.id}:${apiData?.seasonId}`] = {
                            takenAt: Date.now(),
                            takenInState: 'post-draft-preseason',
                            seasonId: apiData?.seasonId ?? null,
                            players
                        };
                    }
                    // ?rankingsStaging=1 seeds the reader's own rankings file under the app's own key, with the text and name exactly as the panel's file input would have written them, so the loaded state can be staged headless with no file dialog. tests/fixtures/rankings-staging.csv names real players out of the loaded pool, not synthetic ids.
                    if (params.get('rankingsStaging') === '1') {
                        const sport = { 1: 'ffl', 2: 'flb', 4: 'fhl' }[apiData?.gameId] || store.sport;
                        const text = await fetch('tests/fixtures/rankings-staging.csv').then(r => r.text());
                        store[`rankingsFile:${sport}:${apiData?.id}`] = { name: 'rankings-staging.csv', text };
                    }
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
            // A real key-value store, the same fix as storage.local above and for the same reason: this used to answer every get with one fixed pair and drop every set. That hid in api.js's own caches, which read it and fell back to a fresh fetch, but the room state needs a write that a later get reads back.
            session: (() => {
                let store = null;
                const seeded = async () => {
                    if (store) return store;
                    store = {};
                    if (noLeague) return store;
                    const apiData = await payloadPromise;
                    if (!apiData) {
                        console.error(`browser-stub: couldn't load payload "${payloadFile}"`);
                        return store;
                    }
                    store.apiData = apiData;
                    // The real fetch fills this from the leagueHistory endpoint; dev-preview restores from the session cache and never runs that call, so ?seasons= seeds it here or League History would only ever see the loaded season.
                    store.leagueHistoryYears = [...seasonFiles.keys()].map(Number);
                    return store;
                };
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
            })()
        },
        // Recorded, not swallowed. main.js redirects a popup to a full tab through this call, and whether it fires is the single fact that separates a working popup from a sliver, so the harness needs to see it happen. Still a no-op otherwise, because the harness is a tab.
        tabs: {
            create: async (arg) => { (window.__stubTabsCreated = window.__stubTabsCreated || []).push(arg); },
            // The Draft push's transport, page to content script: draftToRoom queries for the room's tab and messages it directly, because a runtime message never reaches a content script. One fake tab is offered when a room replay is running (?room=<fixture>) and none otherwise, which draftToRoom reads as no room tab.
            query: async () => (roomSendMessageHandler ? [{ id: 1 }] : []),
            sendMessage: async (_tabId, msg) => (roomSendMessageHandler ? roomSendMessageHandler(msg) : undefined)
        },
        // Always granted, so the dev flow never sees the Firefox opt-in prompt checkAuth renders for a store install (see hasEspnHostAccess in api.js). request() is here for shape only: nothing in dev-preview can reach it while contains() answers true.
        permissions: {
            contains: async () => true,
            request: async () => true
        },
        runtime: {
            getURL: (p) => p,
            // The page's own listener (draft-view.js). The real signature is (message, sender, sendResponse); sender is never read by a page-side listener, so an empty object stands in for it.
            onMessage: {
                addListener: (fn) => { roomListeners.push(fn); },
                removeListener: (fn) => {
                    const i = roomListeners.indexOf(fn);
                    if (i !== -1) roomListeners.splice(i, 1);
                }
            },
            // Unused by product code now that the Draft push moved to tabs.sendMessage above, since a runtime message from the page never reaches a content script. Kept as a plain stub, matching a real sendMessage with no listener on the other end, rather than removed, because the shape still has to exist for anything else that calls it.
            sendMessage: async () => undefined
        }
    };

    // ?room=<fixture> is the stub's own replay of a draft room feed, never product code. It writes the roomState shape from tests/fixtures/<fixture>.json so Following the room can be staged with no room, and remaps the fixture's synthetic ids onto the loaded league's own teams and players. room-feed.js is imported dynamically so this file stays a classic script that sets window.browser before compat.js runs.
    if (params.get('room')) {
        setupRoomReplay(params.get('room')).catch(err => console.error('browser-stub: room replay failed', err));
    }

    async function setupRoomReplay(fixtureName) {
        const [{ parseRoomLine, applyRoomFacts, roomStatus }, fixture, apiData] = await Promise.all([
            import('../src/data/room-feed.js'),
            fetchJson(`tests/fixtures/${fixtureName}.json`),
            payloadPromise
        ]);
        if (!fixture || !apiData) return;

        // The i-th team in draft order is read from settings.draftSettings.pickOrder, the same field firstRoundOrder and companionOrder read, because plain team-list order made the wrong team read as mine for a reader on the clock fourth. Reading it directly needs no snake expansion, which this classic script could not import anyway.
        const realTeamIds = (Array.isArray(apiData.settings?.draftSettings?.pickOrder) && apiData.settings.draftSettings.pickOrder.length
            ? apiData.settings.draftSettings.pickOrder
            : (apiData.teams || []).map(t => t.id)).filter(id => id !== undefined && id !== null);
        const teamMap = new Map((fixture.teams || []).map((synthId, i) =>
            [synthId, realTeamIds.length ? realTeamIds[i % realTeamIds.length] : synthId]));

        let realPlayersByAdp = [];
        if (playersFile) {
            const pool = await fetchJson(playersFile);
            const list = Array.isArray(pool) ? pool : (pool?.players || []);
            realPlayersByAdp = list
                .map(entry => {
                    const player = entry?.player || entry;
                    const own = entry?.ownership || player?.ownership || {};
                    const adp = Number(own.averageDraftPosition);
                    return player && player.id !== undefined && player.id !== null
                        ? { id: player.id, adp: adp > 0 ? adp : Infinity, name: player.fullName || '', pos: player.defaultPositionId }
                        : null;
                })
                .filter(Boolean)
                .sort((a, b) => a.adp - b.adp);
        }
        const playerMap = new Map((fixture.players || []).map((synthId, i) =>
            [synthId, realPlayersByAdp.length ? realPlayersByAdp[i % realPlayersByAdp.length].id : synthId]));
        const reversePlayerMap = new Map([...playerMap].map(([synth, real]) => [real, synth]));

        const sport = { 1: 'ffl', 2: 'flb', 4: 'fhl' }[apiData.gameId] || 'flb';
        const leagueId = apiData.id;
        const seasonId = apiData.seasonId;
        const teams = realTeamIds.length || (fixture.teams || []).length;

        // Grown one fact at a time, in real ids throughout, so applyRoomFacts and roomStatus never see a synthetic id and a Draft press (below) can push straight onto the same array without a second remap step back.
        const facts = [];

        // &roomBoard=N synthesizes the room's own board read: the first N overalls, each a real pool player's name (the players the replay drafts, by ADP) so the page's name lookup has something to resolve. Club is empty, position is the coarse F/D/G pill, and every cell carries a name and no id, as the real page does. &roomBoardBad=K names overall K something no pool holds.
        const boardN = Number(params.get('roomBoard') || 0);
        const boardBad = Number(params.get('roomBoardBad') || 0);
        const buildBoard = () => {
            if (!(boardN > 0) || !realPlayersByAdp.length) return null;
            const cols = teams || 1;
            const picks = [];
            for (let overall = 1; overall <= boardN; overall++) {
                const round = Math.ceil(overall / cols);
                const inRound = ((overall - 1) % cols) + 1;
                const real = realPlayersByAdp[(overall - 1) % realPlayersByAdp.length];
                const name = overall === boardBad ? 'Nobody Nowhere' : real.name;
                const parts = name.split(' ');
                picks.push({
                    overall, round, pickInRound: inRound, column: round % 2 ? inRound : cols + 1 - inRound, mine: false,
                    name, firstName: parts[0], lastName: parts.slice(1).join(' '), proTeam: '',
                    position: real.pos >= 1 && real.pos <= 3 ? 'F' : (real.pos === 4 ? 'D' : (real.pos === 5 ? 'G' : ''))
                });
            }
            return { at: Date.now(), why: 'start', columns: cols, rounds: Math.ceil(boardN / cols), picks, refused: [] };
        };
        const writeSnapshot = async (overrides) => {
            const merged = applyRoomFacts(null, facts, { teams }).log;
            const status = roomStatus(facts, { teams, now: Date.now() });
            const snapshot = {
                leagueId, seasonId, sport, status: 'open', at: Date.now(),
                onClock: status.onClock, msRemaining: status.msRemaining,
                picks: merged.picks.map(p => ({ overall: p.overall, teamId: p.teamId, playerId: p.playerId, at: p.at ?? null })),
                lastPickAt: status.lastPickAt,
                ...(boardN > 0 ? { board: buildBoard() } : {}),
                ...overrides
            };
            // storage.local, not storage.session, because the real reader's api.js pair reads and writes local now, so a replay that still wrote session would leave the page reading nothing at all.
            await browser.storage.local.set({ roomState: snapshot });
            roomListeners.forEach(fn => { try { fn({ kind: 'lw-room', roomState: snapshot }, {}, () => {}); } catch { /* a listener's own render error is not this stub's to swallow silently, but it also must not stop the next one firing */ } });
            return snapshot;
        };

        // &roomStatus=closed / &roomAt=stale skip the timed replay, so the whole feed lands at once and then the one override that state is for is applied, and a capture aiming at stale or closed is not also racing the animation to get there.
        const forceStatus = params.get('roomStatus');
        const forceStale = params.get('roomAt') === 'stale';
        if (forceStatus === 'closed' || forceStale) {
            (fixture.feed || []).forEach(({ line, at }) => {
                const fact = parseRoomLine(line, at);
                if (!fact) return;
                facts.push(remapFact(fact, teamMap, playerMap));
            });
            const overrides = {};
            if (forceStatus === 'closed') overrides.status = 'closed';
            if (forceStale) overrides.at = Date.now() - 60000; // past ROOM_STALE_MS (30000) with room to spare
            await writeSnapshot(overrides);
        } else {
            const delayMs = Number(params.get('roomDelay') || 150);
            const maxLines = params.get('roomLines') ? Number(params.get('roomLines')) : (fixture.feed || []).length;
            const lines = (fixture.feed || []).slice(0, maxLines);
            for (const { line, at } of lines) {
                const fact = parseRoomLine(line, at);
                if (fact) {
                    facts.push(remapFact(fact, teamMap, playerMap));
                    await writeSnapshot();
                }
                if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        // The Draft press stands in for the room having taken the pick: a real playerId arrives, teamId is read off the last written snapshot's onClock, and the fact is pushed directly, synthesized fresh and never a fixture line. &roomDraftHold=1 makes the room never answer, so the client's ten-second refusal can be staged deterministically.
        const draftHold = params.get('roomDraftHold') === '1';
        roomSendMessageHandler = async (msg) => {
            if (!msg || msg.kind !== 'lw-draft') return undefined;
            if (draftHold) return undefined;
            const onClockTeam = facts.length ? roomStatus(facts, { teams }).onClock?.teamId : realTeamIds[0];
            setTimeout(() => {
                facts.push({ kind: 'selected', teamId: onClockTeam ?? null, playerId: msg.playerId, at: Date.now() });
                writeSnapshot();
            }, 2000);
            return undefined;
        };

        console.info(`browser-stub: room replay ready (${fixtureName}), ${facts.length ? '' : 'starting '}${(fixture.feed || []).length} lines, ${teamMap.size} teams and ${playerMap.size} players remapped.`);
    }

    function remapFact(fact, teamMap, playerMap) {
        const mapped = { ...fact };
        if ('teamId' in mapped && teamMap.has(mapped.teamId)) mapped.teamId = teamMap.get(mapped.teamId);
        if ('playerId' in mapped && playerMap.has(mapped.playerId)) mapped.playerId = playerMap.get(mapped.playerId);
        return mapped;
    }
})();
