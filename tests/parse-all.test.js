// Does every shipped script parse? The entry points come from manifest.json and the script tags of the two HTML pages, and every import is followed from there, so no list is held here. A module is imported, since a browser has no way to parse one without running it: a SyntaxError fails the suite, and any other error is a module that parsed and then threw on a bare page, which is reported apart.
const results = [];
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const ROOT = '../';

// The check for a classic script, as one function, so the self-check below compiles the broken fixture through exactly the code path every shipped classic script goes through.
function parseFailureOf(text) {
    try { new Function(text); return null; } catch (e) { return `${e.constructor.name}: ${e.message}`; }
}
async function textOf(path) {
    const res = await fetch(ROOT + path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.text();
}

// A relative specifier is resolved against the file that wrote it, as a path from the extension's root. A specifier that climbs out of the root, or is no path to a script, is refused and reported as its own failure below.
function resolveSpecifier(from, spec) {
    // A path with no leading dot is from the extension's own root, not a package. The content script reaches a module through such a path, and it must stay a literal so the packaging tools can follow it.
    if (!spec.startsWith('.')) return /^[\w./-]+\.js$/.test(spec) ? spec : null;
    const parts = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
    for (const piece of spec.split('/')) {
        if (piece === '.' || piece === '') continue;
        if (piece === '..') { if (!parts.length) return null; parts.pop(); continue; }
        parts.push(piece);
    }
    return parts.join('/');
}

// Static imports and re-exports, and the dynamic import. The specifier must be a literal in each. An import whose braced list spans several lines counts: the pattern forbids a semicolon in the body, which is what ends a statement, so a match cannot run on into the next one.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)(?:(?!\bfrom\b)[^;'\"])*from\s*['\"]([^'\"]+)['\"]/g;
const DYNAMIC_RE = /import\(\s*(?:browser\.runtime\.getURL\(\s*)?['"]([^'"]+)['"]/g;

function importsIn(text) {
    const found = new Set();
    for (const m of text.matchAll(IMPORT_RE)) found.add(m[1]);
    for (const m of text.matchAll(DYNAMIC_RE)) found.add(m[1]);
    return [...found];
}

// ---- the entry points, from the shipped files that name them --------------------------------
const manifest = JSON.parse(await textOf('manifest.json'));
const classicEntries = new Set();
const moduleEntries = new Set();

(manifest.content_scripts || []).forEach(cs => (cs.js || []).forEach(js => classicEntries.add(js)));
// A web-accessible resource is reached by the content script's own dynamic import, so it is a module - except room-hook.js, which is injected into the PAGE as a classic script on purpose (its own header says why: it has to wrap the page's globals from inside the page).
(manifest.web_accessible_resources || []).forEach(entry => (entry.resources || []).forEach(res => {
    if (!res.endsWith('.js')) return;
    if (res === 'src/data/room-hook.js') classicEntries.add(res); else moduleEntries.add(res);
}));

// One page is optional, since it is not part of every copy of this repository. Present, it is checked with everything else; absent, it is not a failure.
const PAGES = ['dashboard.html', 'dev-preview.html', 'src/scout/scout.html'];
const OPTIONAL_PAGES = new Set(['src/scout/scout.html']);
for (const page of PAGES) {
    let html;
    try { html = await textOf(page); }
    catch (e) { if (OPTIONAL_PAGES.has(page)) continue; throw e; }
    for (const m of html.matchAll(/<script([^>]*)>/g)) {
        const attrs = m[1];
        const src = /src\s*=\s*"([^"]+)"/.exec(attrs);
        if (!src || /^https?:/.test(src[1])) continue;
        // A tag's path is the page's, so it is resolved against the page: a page two folders down reaches the boot scripts with '../../'.
        const entry = resolveSpecifier(page, src[1].startsWith('.') ? src[1] : './' + src[1]);
        if (entry === null) { unresolved.push(`${page} -> ${src[1]}`); continue; }
        if (/type\s*=\s*"module"/.test(attrs)) moduleEntries.add(entry); else classicEntries.add(entry);
    }
}

// ---- the module graph, followed from those entry points --------------------------------------
const modules = new Set(moduleEntries);
const unresolved = [];
// REPORTED APART, NEVER RED (points 1 and 2 in the header): a file that is not there, and a module that parsed and then threw on a bare page. Both are printed at the end so a reader sees them.
const absent = [];
const threw = [];
const unreached = [];
const queue = [...moduleEntries, ...classicEntries];
const seen = new Set();
while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    let text;
    try { text = await textOf(path); } catch (e) { absent.push(e.message); continue; }
    importsIn(text).forEach(spec => {
        const resolved = resolveSpecifier(path, spec);
        if (resolved === null) { unresolved.push(`${path} -> ${spec}`); return; }
        modules.add(resolved);
        queue.push(resolved);
    });
}
// An entry point that is itself classic is not a module, whatever the graph picked up.
classicEntries.forEach(path => modules.delete(path));

await test('every shipped script is reachable from a shipped entry point', () => {
    // An absent file is not asserted here. A specifier this check cannot resolve is, because that is this suite failing to do its own job and not a file failing to parse.
    assertEq(unresolved.join('; '), '', 'a specifier this check could not resolve');
    // The two ends of the count, so a change in either is visible rather than silent.
    assertEq(classicEntries.size >= 4, true, `at least the four classic scripts - theme-init, compat, room-reader, room-hook - got ${classicEntries.size}`);
    assertEq(modules.size >= 40, true, `the module graph looks too small at ${modules.size}`);
    // NAMED EXPLICITLY, because this file is the one the suite was written for: if room-reader.js ever stops being in the classic set, the check that would have caught 66b4d55 has quietly lapsed.
    assertEq(classicEntries.has('src/data/room-reader.js'), true, 'the content script is in the classic set');
    assertEq(classicEntries.has('src/data/room-hook.js'), true, 'and so is the page-world hook');
});

await test('every CLASSIC script compiles, and none of them runs', async () => {
    // new Function COMPILES and does not call: this is the check room-reader.js needed and the one no suite could give it, since running a content script in a test page is exactly what cannot be done.
    const broken = [];
    for (const path of [...classicEntries].sort()) {
        let text;
        // Absent is absent, not broken (point 2 in the header).
        try { text = await textOf(path); } catch (e) { absent.push(e.message); continue; }
        const failure = parseFailureOf(text);
        if (failure) broken.push(`${path}: ${failure}`);
    }
    assertEq(broken.join(' ;; '), '', 'a classic script does not parse');
});

await test('every MODULE parses, imported once', async () => {
    // An import is the only way a browser will parse a module, so this one executes. A SyntaxError is a parse failure and fails this test. Anything else parsed and then threw while running on a bare test page, which is reported and is not a failure.
    const broken = [];
    for (const path of [...modules].sort()) {
        try {
            await import(ROOT + path);
        } catch (e) {
            if (e instanceof SyntaxError) broken.push(`${path}: ${e.message}`);
            else if (/^Failed to fetch|Importing a module script failed/.test(e.message)) absent.push(`${path}: not fetched`);
            else threw.push(`${path}: ${e.constructor.name}: ${e.message}`);
        }
    }
    assertEq(broken.join(' ;; '), '', 'a module does not parse');
});

await test('the check rejects the real broken file, through the real code path', async () => {
    // A green suite that cannot fail is not a check. tests/fixtures/parse-broken.js.txt holds one line that does not parse, kept as.txt so nothing can import it by accident, and it goes through parseFailureOf, the same function every shipped classic script goes through above.
    let text = null;
    try { text = await textOf('tests/fixtures/parse-broken.js.txt'); } catch { /* absent: reported below */ }
    if (text === null) {
        absent.push('tests/fixtures/parse-broken.js.txt: the self-check fixture');
    } else {
        const failure = parseFailureOf(text);
        assertEq(failure === null, false, 'the fixture must not parse - it is the bug');
        assertEq(failure.startsWith('SyntaxError'), true, `and it must fail as a SyntaxError, got ${failure}`);
    }
    // And a shape with nothing to do with apostrophes, so the check is not one pattern deep.
    assertEq((parseFailureOf('const x = (1 +;') || '').startsWith('SyntaxError'), true, 'an unbalanced expression');
    assertEq(parseFailureOf('const x = 1;'), null, 'while a file that parses passes');

    // And the real file with a fault put back, in memory and never on disk: room-reader.js as it ships, with one string's double quotes turned into single ones around an apostrophe. It is the end-to-end proof that this suite goes red on a script that does not parse.
    const reader = await textOf('src/data/room-reader.js');
    const fixed = reader.indexOf('" picks from this room') !== -1;
    assertEq(fixed, true, 'the shipped line is the fixed one');
    const reBroken = reader.replace("\" picks from this room's own snapshot\"", "' picks from this room's own snapshot'");
    assertEq(parseFailureOf(reader), null, 'the file as it ships parses');
    assertEq((parseFailureOf(reBroken) || '').startsWith('SyntaxError'), true, 'and with 66b4d55\'s quoting it does not');
});

// The toolbar icon pair, held the right way round. Firefox's theme_icons keys read backwards: dark is the icon for a theme whose text is dark, which is a light toolbar, and light is the icon for a dark toolbar. So dark takes the brand's toolbar-light file and light its toolbar-dark one. Swapping them looks like a correction and is not, so the pairing is asserted.
await test('the toolbar icons are paired to the theme the way Firefox reads the keys', () => {
    const pairs = (manifest.action && manifest.action.theme_icons) || [];
    assertEq(pairs.map(p => p.size).join(','), '16,32', 'one pair at each toolbar size');
    assertEq(pairs.map(p => p.dark).join(','), 'icons/toolbar-light-16.png,icons/toolbar-light-32.png',
        '"dark" is dark TEXT, a light toolbar: the light-toolbar file');
    assertEq(pairs.map(p => p.light).join(','), 'icons/toolbar-dark-16.png,icons/toolbar-dark-32.png',
        '"light" is light TEXT, a dark toolbar: the dark-toolbar file');
});

await test('a root file the derivation never reached is named', async () => {
    // AN ORPHAN IS HOW A DEAD FILE HIDES. The root list comes from sync-mirror.ps1's own arrays, which are what ships; comment lines are stripped BEFORE the quoted names are read, because a comment carrying an apostrophe is exactly what desynchronised the gate's own reader once (its lists say so).
    let script = null;
    try { script = await textOf('scripts/sync-mirror.ps1'); } catch { /* the mirror has no scripts dir */ }
    if (script === null) {
        unreached.push('sync-mirror.ps1 is not here, so no root list could be read - orphans unchecked');
        return;
    }
    const listed = new Set();
    script.split('\n').filter(line => !/^\s*#/.test(line)).forEach(line => {
        for (const m of line.matchAll(/'([^']+\.js)'/g)) {
            // The shipped scripts: the two beside the manifest, and everything under src/.
            if (!m[1].includes('/') || m[1].startsWith('src/')) listed.add(m[1]);
        }
    });
    const reached = new Set([...modules, ...classicEntries]);
    [...listed].sort().forEach(path => { if (!reached.has(path)) unreached.push(path); });
    // Reported, not red: a shipped file no entry point reaches is a question for a person. It is either a dead file or an entry point this derivation does not know about.
    assertEq(listed.size > 40, true, `the root list looks too small at ${listed.size}`);
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
const apart = [
    ['derived list', `${classicEntries.size} classic: ${[...classicEntries].sort().join(', ')}`],
    ['', `${modules.size} modules: ${[...modules].sort().join(', ')}`],
    ['absent (not a failure)', absent.length ? absent.join('; ') : 'none'],
    ['parsed then threw on a bare page (not a failure)', threw.length ? threw.join('; ') : 'none'],
    ['shipped but unreached by the derivation', unreached.length ? unreached.join('; ') : 'none']
];
document.getElementById('results').innerHTML += apart
    .map(([label, body]) => `<div style="margin-top:8px">${label ? `<b>${label}</b>: ` : ''}${body}</div>`)
    .join('');
console.log(`parse-all: ${classicEntries.size} classic scripts, ${modules.size} modules checked`);
apart.slice(2).forEach(([label, body]) => console.log(`parse-all ${label}: ${body}`));
window.__TEST_RESULTS = { passed, failed: results.length - passed, total: results.length, failures: results.filter(r => !r.ok) };
window.__PARSE_ALL = { classic: [...classicEntries].sort(), modules: [...modules].sort(), absent, threw, unreached };
