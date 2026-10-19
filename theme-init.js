/**
 * Applies the saved style and theme synchronously, before the stylesheet paints, so there is no
 * flash of one into the other. Only an explicit light or dark choice sets `data-theme`; "auto"
 * leaves it unset so the color-scheme media query drives it, and one of the two styles always applies.
 *
 * This is a plain synchronous script in its own file, loaded before the stylesheet link. Extension
 * pages block inline scripts, and making it a module or loading it later brings the flash back.
 *
 * @module theme-init
 */
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
