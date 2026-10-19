// Unit tests for the pure note renderer (markdown-lite.js), with expected values hand-written from tests/fixtures/markdown-lite.md. The injection cases are the point: this module emits markup into an extension page with cookie access, so each asserts that a hostile construct came back as escaped, inert text and never as a tag, attribute or href.
import { renderMarkdownLite, escapeHtml } from '../src/views/markdown-lite.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// What a browser actually does with the output, which is the only question that matters for the injection cases: parsed into a detached element, is there a tag we did not write, and does the visible text still read as what was typed?
function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}
function tagsIn(html) {
    return Array.from(parse(html).querySelectorAll('*')).map(n => n.tagName.toLowerCase());
}

// ==== the subset ====

test('the subset: bold, italic, code, and a line break', () => {
    assertEq(renderMarkdownLite('**bold**'), '<strong>bold</strong>', 'bold');
    assertEq(renderMarkdownLite('*italic*'), '<em>italic</em>', 'italic');
    assertEq(renderMarkdownLite('`code`'), '<code>code</code>', 'inline code');
    assertEq(renderMarkdownLite('one\ntwo'), 'one<br>two', 'a newline is a break');
    assertEq(renderMarkdownLite('one\r\ntwo'), 'one<br>two', 'and so is a CRLF, once');
    assertEq(renderMarkdownLite('**a** and *b*'), '<strong>a</strong> and <em>b</em>',
        'bold runs before italic, or the two asterisks read as an empty italic');
    assertEq(renderMarkdownLite('`**not bold**`'), '<code>**not bold**</code>',
        'code runs first, so asterisks inside it are characters');
});

test('the subset: a bullet list needs the space after the hyphen', () => {
    assertEq(renderMarkdownLite('- one\n- two'), '<ul><li>one</li><li>two</li></ul>', 'two items');
    assertEq(renderMarkdownLite('why:\n- one\n- two'), 'why:<ul><li>one</li><li>two</li></ul>',
        'a run of text, then the list');
    assertEq(renderMarkdownLite('- **one**'), '<ul><li><strong>one</strong></li></ul>', 'items take the inline grammar');
    assertEq(renderMarkdownLite('-3 goals'), '-3 goals', 'a negative number at the start of a line is text');
    assertEq(renderMarkdownLite('-'), '-', 'and so is a lone hyphen');
});

test('the subset: empty in, empty out, and no trailing break', () => {
    assertEq(renderMarkdownLite(''), '', 'empty');
    assertEq(renderMarkdownLite('   \n  '), '', 'whitespace only');
    assertEq(renderMarkdownLite(null), '', 'null');
    assertEq(renderMarkdownLite(undefined), '', 'undefined');
    assertEq(renderMarkdownLite('one\n\n'), 'one', 'trailing blank lines are dropped');
    assertEq(renderMarkdownLite('one\n\ntwo'), 'one<br><br>two', 'a blank line between two is still a break');
});

// ==== links ====

test('links: http and https only, with the rel and target fixed', () => {
    assertEq(renderMarkdownLite('[site](https://example.com)'),
        '<a href="https://example.com" rel="noopener noreferrer" target="_blank">site</a>', 'https');
    assertEq(renderMarkdownLite('[site](http://example.com/a?b=1&c=2)'),
        '<a href="http://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">site</a>',
        'http, and the ampersand stays an entity in the attribute');
    assertEq(renderMarkdownLite('[](https://example.com)'),
        '<a href="https://example.com" rel="noopener noreferrer" target="_blank">https://example.com</a>',
        'an empty label falls back to the address');
    const a = parse(renderMarkdownLite('[site](https://example.com)')).querySelector('a');
    assertEq(a.getAttribute('rel'), 'noopener noreferrer', 'noopener keeps the opened page off window.opener');
    assertEq(a.getAttribute('target'), '_blank', 'a note link opens away from the page holding the session');
});

test('links: the label is not parsed, so a nested construct is TEXT', () => {
    const html = renderMarkdownLite('[**x**](https://example.com)');
    assertEq(html, '<a href="https://example.com" rel="noopener noreferrer" target="_blank">**x**</a>',
        'the anchor reads the literal asterisks - no second grammar inside a link');
    assertEq(parse(html).querySelector('a').textContent, '**x**', 'and that is what the reader sees');
    assertEq(tagsIn(html).length, 1, 'one tag, the anchor, and nothing nested in it');
    // Inline code is resolved before links, so it is already a finished fragment when the link is seen. It is the one construct that does carry through, and the contract says so.
    assertEq(renderMarkdownLite('[`x`](https://example.com)'),
        '<a href="https://example.com" rel="noopener noreferrer" target="_blank"><code>x</code></a>',
        'code was finished before the link existed');
});

// ==== the injection cases ====

test('injection: a script tag is text, not a tag', () => {
    const html = renderMarkdownLite('<script>alert(1)</script>');
    assertEq(html, '&lt;script&gt;alert(1)&lt;/script&gt;', 'escaped whole');
    assertEq(tagsIn(html).length, 0, 'the browser parses NO element out of it');
    assertEq(parse(html).textContent, '<script>alert(1)</script>', 'and it reads as what was typed');
});

test('injection: an onerror attribute never becomes an attribute', () => {
    const html = renderMarkdownLite('<img src=x onerror=alert(1)>');
    assertEq(tagsIn(html).length, 0, 'no img node, so nothing to fire');
    assertEq(parse(html).textContent, '<img src=x onerror=alert(1)>', 'printed as text');
    // The same text hidden inside the constructs this module does render. The escape happened first, so the parser never meets a tag wherever it was put.
    assert(!renderMarkdownLite('**<img src=x onerror=alert(1)>**').includes('<img'), 'not inside bold');
    assert(!renderMarkdownLite('- <img src=x onerror=alert(1)>').includes('<img'), 'not inside a list item');
    assert(!renderMarkdownLite('`<img src=x onerror=alert(1)>`').includes('<img'), 'not inside code');
    assertEq(tagsIn('' + renderMarkdownLite('[<img src=x onerror=alert(1)>](https://example.com)')).join(','),
        'a', 'and not inside a link label - the anchor is the only element');
});

test('injection: a javascript: url is never an href', () => {
    const html = renderMarkdownLite('[click](javascript:alert(1))');
    assertEq(tagsIn(html).length, 0, 'no anchor at all');
    assertEq(parse(html).textContent, '[click](javascript:alert(1))', 'the whole construct prints as text');
    ['data:text/html,<b>x</b>', 'vbscript:msgbox(1)', '//example.com/p', '/local/path', 'ftp://example.com']
        .forEach(url => {
            const out = renderMarkdownLite(`[x](${url})`);
            assertEq(out.includes('<a '), false, `${url} is not a link`);
        });
    // Case and padding do not sneak one past: the test is anchored and case-insensitive.
    assertEq(renderMarkdownLite('[x](HTTPS://example.com)').includes('<a '), true, 'upper case http is still http');
    assertEq(renderMarkdownLite('[x](xhttps://example.com)').includes('<a '), false, 'and a prefix is not a scheme');
});

test('injection: a quote in a url cannot break out of the attribute', () => {
    const html = renderMarkdownLite('[x](https://example.com/"onmouseover="alert(1))');
    const el = parse(html).querySelector('a');
    assert(el === null || el.getAttribute('onmouseover') === null, 'no event attribute is ever parsed');
    assertEq(html.includes('onmouseover="'), false, 'the quote is an entity by the time the href is written');
    assertEq(escapeHtml('"'), '&quot;', 'because the whole text was escaped before any of this ran');
});

test('injection: the placeholder sentinel cannot be typed in', () => {
    // Finished fragments are parked under a U+0000 marker while bold and italic run. A note carrying one could otherwise address a parked fragment, so it is stripped from the input before anything else happens.
    const html = renderMarkdownLite('\u00000\u0000 **x** `y`');
    assertEq(html.includes('\u0000'), false, 'no sentinel survives into the output');
    assertEq(html, '0 <strong>x</strong> <code>y</code>', 'and the digit that was beside it is just a digit');
});

// ==== a real note ====

test('a note the owner would actually write', () => {
    const note = [
        'Sleeper, **do not** reach.',
        '- ADP 120, our value says 90',
        '- second line rushing, per [the depth chart](https://example.com/depth)',
        'Watch `GP` in March.'
    ].join('\n');
    assertEq(renderMarkdownLite(note),
        'Sleeper, <strong>do not</strong> reach.'
        + '<ul><li>ADP 120, our value says 90</li>'
        + '<li>second line rushing, per <a href="https://example.com/depth" rel="noopener noreferrer" target="_blank">the depth chart</a></li></ul>'
        + 'Watch <code>GP</code> in March.',
        'text, a list with a link in it, then text again');
    assert(note.length < 1000, 'and it fits the new NOTE_MAX with room to spare');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
