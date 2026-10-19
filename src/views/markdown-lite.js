/**
 * A small, safe Markdown subset for notes the reader typed: bold, italic, code, line breaks,
 * dash lists and http(s) links.
 *
 * Pure. In goes a string someone typed and out comes a string of HTML a view can insert. The whole
 * text is escaped first and markup is built from the escaped text only, so a construct this module
 * does not recognise prints as text and never as a hole. The grammar is deliberately small, since
 * every extra construct is a place an escape could be undone.
 *
 * Contract: tests/fixtures/markdown-lite.md
 * @module markdown-lite
 */

/**
 * Escapes the five HTML-significant characters. This is a copy of the application's own escaper,
 * kept here so the renderer runs in isolation; the two must not diverge.
 *
 * @param {*} str The value.
 * @returns {string} The escaped text.
 */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Only http and https reach an href, tested on the escaped url that will be written; anything else prints as the text typed.
const SAFE_URL = /^https?:\/\/[^\s]+$/i;

// A placeholder no typed text can contain, so a finished fragment parked under it is never re-parsed.
const MARK = '\u0000';

/**
 * Renders a note to safe HTML.
 *
 * @param {*} text The typed text; null and undefined read as empty.
 * @returns {string} The markup, or an empty string for empty or whitespace-only text.
 */
export function renderMarkdownLite(text) {
    const raw = String(text === null || text === undefined ? '' : text)
        .replace(/\u0000/g, '')      // see MARK; the input may not carry the sentinel
        .replace(/\r\n?/g, '\n');
    if (!raw.trim()) return '';

    const escaped = escapeHtml(raw);
    const lines = escaped.split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

    const blocks = [];
    let run = [];
    let items = [];
    const flushRun = () => { if (run.length) { blocks.push(run.map(inline).join('<br>')); run = []; } };
    const flushList = () => {
        if (!items.length) return;
        blocks.push(`<ul>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`);
        items = [];
    };

    lines.forEach(line => {
        // "- " and not "-": a lone hyphen, and a negative number at the start of a line, are text.
        const bullet = /^\s*-\s+(.*)$/.exec(line);
        if (bullet) { flushRun(); items.push(bullet[1]); return; }
        flushList();
        run.push(line);
    });
    flushRun();
    flushList();
    return blocks.join('');
}

// Code is taken first so `**` inside it is never emphasis, then links so their text is parked whole, then bold before italic.
function inline(escapedLine) {
    const parked = [];
    const park = (html) => `${MARK}${parked.push(html) - 1}${MARK}`;

    let out = escapedLine
        .replace(/`([^`]+)`/g, (_, code) => park(`<code>${code}</code>`))
        .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
            if (!SAFE_URL.test(url)) return whole;   // printed as the text it is, never as a link
            // A link's label is not parsed, since a second grammar inside a link is a second place for an escape to come undone. The rel and target are fixed so the opened page stays off window.opener.
            return park(`<a href="${url}" rel="noopener noreferrer" target="_blank">${label || url}</a>`);
        })
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

    // Restored until stable, because a parked fragment can hold another; the pass count is bounded so a malformed marker cannot spin.
    const slot = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
    for (let pass = 0; pass <= parked.length && slot.test(out); pass++) {
        slot.lastIndex = 0;
        out = out.replace(slot, (whole, i) => (parked[Number(i)] === undefined ? whole : parked[Number(i)]));
        slot.lastIndex = 0;
    }
    return out;
}
