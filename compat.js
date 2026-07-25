// Chrome and Edge have no browser global. Every WebExtension call this app makes is promise-native in MV3, so aliasing the name is enough, and loading this as a classic script before the module guarantees it runs first.
if (typeof browser === 'undefined') globalThis.browser = chrome;
