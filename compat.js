// Chrome and Edge have no browser global (Firefox has both). Every WebExtension call this
// app makes is promise-native in Chrome's MV3, so aliasing the name is enough here, no
// polyfill needed. Loaded as a classic script before the module script so it always runs
// first (classic-before-module is a guaranteed order).
if (typeof browser === 'undefined') globalThis.browser = chrome;
