// Applies the saved STYLE and theme synchronously, before the stylesheet paints, so there's no flash of one into the other. Only an explicit light/dark choice sets data-theme; "auto" leaves it unset so the prefers-color-scheme media query drives it. Style is not optional in the same way: one of the two always applies, and Boxscore is what a new install gets. This lives in its own file (not inline in dashboard.html) because extension pages run under a CSP that blocks inline scripts entirely - as an inline snippet this never executed in the installed extension, only in dev-preview. It must stay a plain synchronous script loaded BEFORE the stylesheet link; making it a module or moving it after the CSS reintroduces the flash it exists to prevent.
(function () {
    try {
        // Anything unrecognised, including a first run with nothing stored, is Boxscore.
        var s = localStorage.getItem('efv-style');
        document.documentElement.setAttribute('data-style', s === 'modern' ? 'modern' : 'boxscore');
    } catch (e) {
        document.documentElement.setAttribute('data-style', 'boxscore');
    }
    try {
        var t = localStorage.getItem('efv-theme');
        if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    } catch (e) { }
})();
