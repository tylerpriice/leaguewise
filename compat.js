/**
 * Cross-browser shim, loaded as a classic script before the module script.
 *
 * Chrome and Edge have no `browser` global, so this aliases it to `chrome`; every WebExtension call
 * the app makes is promise-native there, so the alias is enough. Where a page is opened straight off
 * a static server and `browser.storage` is missing, it also supplies a localStorage-backed
 * `storage.local` and an in-memory `storage.session`.
 *
 * @module compat
 */
if (typeof browser === 'undefined') globalThis.browser = typeof chrome !== 'undefined' ? chrome : {};

// Pages opened off a static server get a `chrome` global but no `chrome.storage`, so the first storage call would throw. The fallback is backed by localStorage so a reload still finds what was saved, and it covers both areas and all three verbs.
if (!globalThis.browser.storage || !globalThis.browser.storage.local) {
    const STORE_KEY = '__leaguewiseCompatStorage';
    const readStore = () => {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
    };
    const writeStore = (store) => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* quota or disabled */ }
    };
    // One reader shape, matching the development stub: null or undefined gives everything, a string gives that key, an array gives those keys. An absent key is missing from the answer, never present as undefined.
    const pick = (all, keys) => {
        if (keys === null || keys === undefined) return { ...all };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        list.forEach(k => { if (k in all) out[k] = all[k]; });
        return out;
    };
    const dropKeys = (all, keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete all[k]; });
        return all;
    };
    // Session is in memory for the life of the page. That is stricter than the real area and enough, since every session read is a cache with a fetch behind it.
    const sessionStore = {};
    globalThis.browser = {
        ...globalThis.browser,
        storage: {
            local: {
                get: async (keys) => pick(readStore(), keys),
                set: async (obj) => { writeStore({ ...readStore(), ...(obj || {}) }); },
                remove: async (keys) => { writeStore(dropKeys(readStore(), keys)); }
            },
            session: {
                get: async (keys) => pick(sessionStore, keys),
                set: async (obj) => { Object.assign(sessionStore, obj || {}); },
                remove: async (keys) => { dropKeys(sessionStore, keys); }
            }
        }
    };
}
