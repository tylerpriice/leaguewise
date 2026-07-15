// Applies the saved theme before the stylesheet paints so there's no light-then-dark flash.
// External file on purpose: extension-page CSP blocks inline scripts. Must stay a plain synchronous script loaded before the stylesheet link.
(function () {
    try {
        var t = localStorage.getItem('efv-theme');
        if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    } catch (e) { }
})();
