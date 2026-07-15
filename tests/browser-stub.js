// DEV-ONLY stub of the WebExtension `browser` API, used solely by dev-preview.html (which is not referenced by manifest.json and never ships).
(function () {
    if (window.browser) return;

    const params = new URLSearchParams(location.search);
    const payloadName = params.get('payload') || 'espn-debug-1783444818700.json';
    const payloadFile = payloadName.includes('/') ? payloadName : `JSON_debug/${payloadName}`;
    const anonymize = params.get('anon') === '1';

    // ?anon=1 renames every team and manager before the dashboard sees the payload, so screenshots of real league data carry no real names.
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

    // Falls back to the bundled anonymized sample league when no captured payload exists, so a fresh clone runs the full dashboard with zero setup.
    const SAMPLE_FILE = 'tests/sample-league.json';
    const fetchJson = (file) => fetch(file).then(r => r.ok ? r.json() : null).catch(() => null);
    const payloadPromise = fetchJson(payloadFile)
        .then(data => data || fetchJson(SAMPLE_FILE))
        .then(data => (data && anonymize) ? anonymizePayload(data) : data);

    // ?players=<file> serves a captured player-pool JSON for the pool fetch so the Player Metrics tab runs offline. Weekly-stats calls (same endpoint, scoring-period filter header) pass through and fail down their normal path.
    const playersName = params.get('players');
    if (playersName) {
        const playersFile = playersName.includes('/') ? playersName : `JSON_debug/${playersName}`;
        const realFetch = window.fetch.bind(window);
        window.fetch = (url, options) => {
            const isKona = typeof url === 'string' && url.includes('kona_player_info');
            const filterHeader = options?.headers?.['X-Fantasy-Filter'] || '';
            const isWeekly = filterHeader.includes('filterStatsForTopScoringPeriodIds');
            if (isKona && !isWeekly) return realFetch(playersFile);
            return realFetch(url, options);
        };
    }

    window.browser = {
        cookies: {
            // Fake cookies so checkAuth passes and the dashboard renders clean. The league picker's fan-profile fetch fails harmlessly (it's already best-effort).
            get: async ({ name }) => {
                if (name !== 'SWID') return { name, value: 'dev' };
                const apiData = await payloadPromise;
                const owner = apiData?.teams?.find(t => t.primaryOwner)?.primaryOwner;
                return { name, value: owner || '' };
            }
        },
        storage: {
            local: {
                get: async () => ({ sport: 'flb', leagueId: 'dev-preview', year: '2025' }),
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
        runtime: { getURL: (p) => p }
    };
})();
