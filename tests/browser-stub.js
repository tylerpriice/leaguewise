// DEV-ONLY stub of the WebExtension `browser` API, used solely by dev-preview.html (which is not referenced by manifest.json and never ships).
(function () {
    if (window.browser) return;

    const params = new URLSearchParams(location.search);
    const payloadName = params.get('payload') || 'espn-debug-1783444818700.json';
    const payloadFile = payloadName.includes('/') ? payloadName : `JSON_debug/${payloadName}`;
    const payloadPromise = fetch(payloadFile).then(r => r.ok ? r.json() : null).catch(() => null);

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
