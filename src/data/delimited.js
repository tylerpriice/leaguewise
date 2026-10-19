/**
 * Reading a delimited file, and joining one to a pool by name. A delimiter is a delimiter and a
 * header map is a parameter, so nothing here belongs to any one platform's export.
 *
 * Pure. No DOM, no application state, no storage and no network.
 *
 * Tests: tests/rankings-file.test.html
 * @module delimited
 */
/**
 * One row of a file after the header map has been applied.
 *
 * @typedef {object} MappedRow
 * @property {string|number} id The file's own id for the row, or the row's ordinal when the file carries none.
 * @property {string} name The name.
 * @property {string} club The club.
 * @property {string[]} positions The positions listed.
 * @property {string[]} eligiblePositions The same positions, under the name the draft engine reads.
 * @property {string} status Who holds the player, when the file says.
 * @property {?number} age The age, when the file says.
 * @property {boolean} eligible Whether the file's eligibility column says yes. False when the map names no such column.
 * @property {Object<string, number>} seasonTotals Every numeric column the map did not name, by its header.
 * @property {Object<string, string>} raw Every cell of the row, by header.
 */

// ==== (a) The reader ====

/**
 * Reads a delimited file by RFC 4180: a quoted cell may hold the delimiter, a quote written twice,
 * or a line break. The delimiter is detected from the first line when none is given.
 *
 * @param {string} text The file's text.
 * @param {object} [options]
 * @param {string} [options.delimiter] The delimiter. Detected when absent.
 * @returns {{delimiter: string, headers: string[], rows: string[][], ragged: number}} The header cells, the rows fitted to the header's length, and how many rows had a different number of cells.
 */
export function readDelimited(text, { delimiter } = {}) {
    // A byte order mark is not a character of the first header. Left in place it would change the first column's name, which would then match no map key.
    let src = String(text == null ? '' : text);
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

    const delim = delimiter || detectDelimiter(src);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let i = 0;
    const push = () => { row.push(cell); cell = ''; };
    const endRow = () => { push(); rows.push(row); row = []; };

    while (i < src.length) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                // A doubled quote inside a quoted field is one literal quote. A single one closes the field.
                if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
                quoted = false; i += 1; continue;
            }
            cell += ch; i += 1; continue;
        }
        if (ch === '"' && cell === '') { quoted = true; i += 1; continue; }
        if (ch === delim) { push(); i += 1; continue; }
        // CRLF and LF both end a row. A lone CR does not, so a quoted field that carries one is not split.
        if (ch === '\r' && src[i + 1] === '\n') { endRow(); i += 2; continue; }
        if (ch === '\n') { endRow(); i += 1; continue; }
        cell += ch; i += 1;
    }
    if (cell !== '' || row.length > 0 || quoted) endRow();

    // A row of one empty cell is a blank line, not a row. Trailing ones are what a file ending in a newline leaves.
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();

    const headers = (rows.shift() || []).map(h => h.trim());
    let ragged = 0;
    const body = rows.map(r => {
        if (r.length === headers.length) return r;
        ragged += 1;
        // Nothing downstream reads a cell by position, since the header map reads by name. So a row with the wrong number of cells is counted and fitted to the header, not refused.
        const out = r.slice(0, headers.length);
        while (out.length < headers.length) out.push('');
        return out;
    });
    return { delimiter: delim, headers, rows: body, ragged };
}

// The first line decides between a tab and a comma, since a header line is the one line sure to hold a separator.
function detectDelimiter(src) {
    const end = src.search(/\r\n|\n/);
    const first = end === -1 ? src : src.slice(0, end);
    let tabs = 0, commas = 0;
    for (const ch of first) { if (ch === '\t') tabs++; else if (ch === ',') commas++; }
    return tabs > commas ? '\t' : ',';
}

// ==== (b) The header map ====

const DEFAULT_ELIGIBLE_WHEN = ['Y', 'YES', 'TRUE', '1'];

// A number as an export writes one. A percent sign, a thousands comma and surrounding space are dropped, and a leading dot is allowed. Anything else is absent, not zero, so the caller decides what absence means in a category.
function numberOf(text) {
    if (text === undefined || text === null) return undefined;
    const s = String(text).trim().replace(/,/g, '').replace(/%$/, '');
    if (s === '') return undefined;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;
    return Number(s);
}

/**
 * Turns a file's rows into mapped rows. The caller names the columns that are not statistics, and
 * every other numeric column is kept as a stat under its own header, so no list of possible
 * categories is held here.
 *
 * @param {string[]} headers The header cells.
 * @param {string[][]} rows The data rows.
 * @param {{id: string, name: string, club: string, positions: string, age: string, eligible: string, status: string, eligibleWhen: string[], positionSplit: string}} map The header names of the columns that are not statistics, the values that mean eligible, and what separates positions.
 * @returns {MappedRow[]} The mapped rows.
 */
export function mapRows(headers, rows, map) {
    const m = map || {};
    const cols = headers || [];
    const named = new Set([m.id, m.name, m.club, m.positions, m.age, m.eligible, m.status].filter(Boolean));
    const eligibleWhen = new Set((m.eligibleWhen || DEFAULT_ELIGIBLE_WHEN).map(v => String(v).trim().toUpperCase()));
    const split = m.positionSplit || ',';
    const at = (row, header) => {
        const i = cols.indexOf(header);
        return i === -1 ? undefined : row[i];
    };

    // A column whose every cell fails to read as a number is not a stat, so a text column the map did not name is not offered as a category.
    const statHeaders = cols.filter((h, i) => !named.has(h) && (rows || []).some(r => numberOf(r[i]) !== undefined));

    return (rows || []).map((r, idx) => {
        const seasonTotals = {};
        statHeaders.forEach(h => {
            const v = numberOf(at(r, h));
            if (v !== undefined) seasonTotals[h] = v;
        });
        const raw = {};
        cols.forEach((h, i) => { raw[h] = r[i]; });
        const posCell = String(at(r, m.positions) || '').trim();
        const flag = String(at(r, m.eligible) || '').trim().toUpperCase();
        const idCell = m.id ? String(at(r, m.id) || '').trim() : '';
        const positions = posCell ? posCell.split(split).map(s => s.trim()).filter(Boolean) : [];
        return {
            // The file's own id when it carries one, and the row's ordinal when it does not. An ordinal shifts when the file is exported again with a row missing; a real id does not.
            id: idCell || (idx + 1),
            name: String(at(r, m.name) || '').trim(),
            club: String(at(r, m.club) || '').trim(),
            positions,
            // The same list under the name the draft engine reads, so its functions take a mapped row as it is.
            eligiblePositions: positions,
            // Who holds this player, when the file says. Empty when the map names no column for it.
            status: m.status ? String(at(r, m.status) || '').trim() : '',
            age: numberOf(at(r, m.age)) ?? null,
            // A file that does not say is not saying yes. With no eligibility column every row reads as not eligible.
            eligible: m.eligible ? eligibleWhen.has(flag) : false,
            seasonTotals,
            raw
        };
    });
}

/**
 * Reduces a name to a comparable form: accents, case and punctuation removed and spaces collapsed.
 *
 * @param {string} text The name.
 * @returns {string} The normalized name.
 */
export function normalizeName(text) {
    return String(text ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// The name column has no default here and must be passed in.

/**
 * Joins a second list to a pool by name, for a list that carries no id the pool knows. Names are
 * compared normalized, and the club is a second key when the list names one. A name that two pool
 * rows share, with no club to tell them apart, is reported as ambiguous and never guessed.
 *
 * @param {MappedRow[]} rows The pool.
 * @param {object[]} otherRows The list to join.
 * @param {object} options
 * @param {string} options.name The list's name column.
 * @param {?string} [options.club] The list's club column.
 * @returns {{pairs: Array<Array<object>>, unmatched: string[], ambiguous: string[]}} Each pool row with its list entry, the names found nowhere, and the names that fit more than one row.
 */
export function joinByName(rows, otherRows, { name, club = null } = {}) {
    const pool = rows || [];
    const byName = new Map();
    const byNameClub = new Map();
    pool.forEach(r => {
        const n = normalizeName(r.name);
        if (!n) return;
        byName.set(n, byName.has(n) ? null : r);   // null MARKS the collision rather than losing it
        byNameClub.set(`${n}|${normalizeName(r.club)}`, r);
    });

    const pairs = [];
    const unmatched = [];
    const ambiguous = [];
    (otherRows || []).forEach(entry => {
        const listName = String(cellOf(entry, name) ?? entry.name ?? '').trim();
        const n = normalizeName(listName);
        if (!n) return;
        const listClub = club ? normalizeName(String(cellOf(entry, club) ?? entry.club ?? '')) : '';
        const hit = (listClub && byNameClub.get(`${n}|${listClub}`)) || byName.get(n);
        if (hit === null) { ambiguous.push(listName); return; }
        if (!hit) { unmatched.push(listName); return; }
        pairs.push([hit, entry]);
    });
    return { pairs, unmatched, ambiguous };
}

/**
 * A cell by its header, from a mapped row's raw cells or from a plain object.
 *
 * @param {object} entry The row or object.
 * @param {string} header The header.
 * @returns {*} The cell, or undefined.
 */
export function cellOf(entry, header) {
    if (!entry) return undefined;
    if (entry.raw && entry.raw[header] !== undefined) return entry.raw[header];
    return entry[header];
}
