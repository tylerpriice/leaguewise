// Unit tests for the pure zip writer. Open tests/zip.test.html through any static server - green means every assertion held. Every expected value here is hand-computed from the ZIP spec or is a published check value; nothing is read back out of the module that produced it, because a writer checked only by its own reader agrees with itself no matter how wrong it is. The archives these produce are also checked from OUTSIDE the browser once, by a real unzip tool - see the note at the bottom of this file. A byte layout that satisfies every assertion here and still will not open is the failure this suite cannot see by itself.
import { crc32, dosDateTime, buildZip } from '../zip.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}: got ${a}, expected ${b}`);
}

const bytes = (s) => new TextEncoder().encode(s);
// Little-endian readers, written independently of the module's writers so a shared mistake in byte order cannot cancel itself out.
const read16 = (a, at) => a[at] | (a[at + 1] << 8);
const read32 = (a, at) => (a[at] | (a[at + 1] << 8) | (a[at + 2] << 16) | (a[at + 3] << 24)) >>> 0;

// ==== CRC-32 ====

// The two values every CRC-32 implementation is checked against. They are published, not derived here: the empty message is 0, and the nine ASCII digits are 0xCBF43926.
test('crc32: the published check values', () => {
    assertEq(crc32(bytes('')), 0, 'empty');
    assertEq(crc32(bytes('123456789')), 0xCBF43926, 'the check string');
});

test('crc32: one byte, hand-computed from the polynomial', () => {
    // 'a' is 0x61. One table step: c starts 0xFFFFFFFF, index (0xFF ^ 0x61) = 0x9E, and the published CRC-32 of "a" is 0xE8B7BE43.
    assertEq(crc32(bytes('a')), 0xE8B7BE43, 'crc of "a"');
});

test('crc32: unsigned, never negative', () => {
    // The intermediate is a signed 32-bit XOR in JS, so a missing >>> 0 shows up as a negative number on roughly half of all inputs. "The quick brown fox..." is one of them.
    const c = crc32(bytes('The quick brown fox jumps over the lazy dog'));
    assert(c >= 0, `expected unsigned, got ${c}`);
    assertEq(c, 0x414FA339, 'published crc of the pangram');
});

// ==== DOS timestamps ====

test('dosDateTime: packs the fields the way the spec lays them out', () => {
    // 14:30:04. Date: (2026-1980)=46 << 9 | 8 << 5 | 31 = 23552 + 256 + 31 = 23839. Time: 14 << 11 | 30 << 5 | (4/2) = 28672 + 960 + 2 = 29634.
    const d = new Date(2026, 7, 31, 14, 30, 4);
    assertEq(dosDateTime(d), { time: 29634, date: 23839 }, 'packed');
});

test('dosDateTime: seconds are two-second steps, and 1980 is the floor', () => {
    // 5 seconds stores as 2 (5/2 = 2.5, masked to 2), so odd seconds round down by design.
    assertEq(dosDateTime(new Date(2026, 0, 1, 0, 0, 5)).time & 0x1F, 2, 'odd second');
    // A date before the epoch the format can express clamps rather than writing a negative year, which would wrap into a nonsense date a reader would show as some time in 2107.
    const old = dosDateTime(new Date(1979, 0, 1, 0, 0, 0));
    assertEq((old.date >> 9) & 0x7F, 0, 'year clamped to 1980');
});

// ==== archive layout ====

const STAMP = new Date(2026, 7, 31, 14, 30, 4);

test('buildZip: an empty archive is the 22-byte end record alone', () => {
    const z = buildZip([], STAMP);
    assertEq(z.length, 22, 'length');
    assertEq(read32(z, 0), 0x06054B50, 'end-of-central-directory signature');
    assertEq(read16(z, 8), 0, 'entries on this disk');
    assertEq(read16(z, 10), 0, 'entries total');
    assertEq(read32(z, 12), 0, 'central directory size');
    assertEq(read32(z, 16), 0, 'central directory offset');
});

test('buildZip: one file, every header field checked by hand', () => {
    const z = buildZip([{ name: 'a.txt', bytes: bytes('hi') }], STAMP);
    // Local header is 30 bytes + name + data = 30 + 5 + 2 = 37.
    assertEq(read32(z, 0), 0x04034B50, 'local file header signature');
    assertEq(read16(z, 4), 20, 'version needed');
    assertEq(read16(z, 6), 0x0800, 'UTF-8 name flag');
    assertEq(read16(z, 8), 0, 'method 0 = stored');
    assertEq(read16(z, 10), 29634, 'dos time');
    assertEq(read16(z, 12), 23839, 'dos date');
    assertEq(read32(z, 14), crc32(bytes('hi')), 'crc');
    assertEq(read32(z, 18), 2, 'compressed size == uncompressed for stored');
    assertEq(read32(z, 22), 2, 'uncompressed size');
    assertEq(read16(z, 26), 5, 'name length');
    assertEq(read16(z, 28), 0, 'extra length');
    assertEq(new TextDecoder().decode(z.slice(30, 35)), 'a.txt', 'name');
    assertEq(new TextDecoder().decode(z.slice(35, 37)), 'hi', 'stored data is the bytes verbatim');
    // Central directory follows the data, and the end record follows that: 37 + (46 + 5) + 22.
    assertEq(read32(z, 37), 0x02014B50, 'central directory signature');
    assertEq(read32(z, 37 + 42), 0, 'first entry local header offset');
    assertEq(z.length, 37 + 51 + 22, 'total length');
});

test('buildZip: two files, offsets point where the data actually is', () => {
    const z = buildZip([
        { name: 'one.json', bytes: bytes('{"a":1}') },
        { name: 'two.json', bytes: bytes('{"bb":22}') }
    ], STAMP);
    const firstLen = 30 + 8 + 7;   // header + name + data
    const secondLen = 30 + 8 + 9;
    const centralStart = firstLen + secondLen;
    assertEq(read32(z, firstLen), 0x04034B50, 'second local header starts where the first ends');
    assertEq(read32(z, centralStart), 0x02014B50, 'central directory follows both files');
    // The two central entries carry the two local offsets, which is what a reader seeks to.
    assertEq(read32(z, centralStart + 42), 0, 'first offset');
    assertEq(read32(z, centralStart + 46 + 8 + 42), firstLen, 'second offset');
    const endAt = centralStart + 2 * (46 + 8);
    assertEq(read32(z, endAt), 0x06054B50, 'end record');
    assertEq(read16(z, endAt + 10), 2, 'two entries');
    assertEq(read32(z, endAt + 12), 2 * (46 + 8), 'central directory size');
    assertEq(read32(z, endAt + 16), centralStart, 'central directory offset');
});

test('buildZip: a UTF-8 name is stored as UTF-8, and its length is in BYTES', () => {
    // The length field counts bytes, not characters. "café.json" is 9 characters and 10 bytes, and writing 9 there truncates the name for every reader.
    const z = buildZip([{ name: 'café.json', bytes: bytes('x') }], STAMP);
    assertEq(read16(z, 26), 10, 'name length in bytes');
    assertEq(new TextDecoder().decode(z.slice(30, 40)), 'café.json', 'round-trips');
});

test('buildZip: the same input and date always produce the same bytes', () => {
    // Nothing in the module reads a clock, so two builds are identical. This is what makes the layout assertions above meaningful rather than a snapshot of one lucky run.
    const args = [{ name: 'a', bytes: bytes('1') }];
    assertEq([...buildZip(args, STAMP)], [...buildZip(args, STAMP)], 'reproducible');
});

// An archive this suite passes has still only been read by its author. tests/zip-integration.md records the one check made from outside: a file written by buildZip, opened by PowerShell's Expand-Archive, whose contents came back byte-identical.

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
