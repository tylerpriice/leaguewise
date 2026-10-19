/**
 * A minimal ZIP writer, so several files can be handed over under one save dialog without a
 * dependency.
 *
 * Entries are stored, not compressed. Method 0 is in the original specification, so every unzip
 * tool reads it, and the archive is the sum of its parts plus about a hundred bytes a file. The
 * layout is the one every reader accepts: a local header and its data per entry, then the central
 * directory, then the end record. There are no data descriptors, no zip64 and no encryption.
 *
 * Pure. Bytes in and bytes out: no DOM, no application state, no clock and no network.
 *
 * Tests: tests/zip.test.html
 * @module zip
 */

// The standard CRC-32 that ZIP requires. The table is built on first use and not when the module loads, so importing the module computes nothing.
let crcTable = null;

function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
}

/**
 * The CRC-32 that ZIP requires, of a byte array. It gives the two published check values: 0 for
 * the empty input and 0xCBF43926 for the text "123456789".
 *
 * @param {Uint8Array|number[]} bytes The bytes.
 * @returns {number} The checksum, as an unsigned 32-bit number.
 */
export function crc32(bytes) {
    if (!crcTable) crcTable = buildCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * A date as the two 16-bit MS-DOS fields ZIP stores: seconds in steps of two, and the year
 * counted from 1980. The date is passed in, so the same input always gives the same archive.
 *
 * @param {Date} date The date.
 * @returns {{time: number, date: number}} The two fields.
 */
export function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() / 2) & 0x1F),
        date: (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
    };
}

// Little-endian writers. ZIP is little-endian throughout, on every platform.
const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

/**
 * Builds one archive of stored entries. Names are written as UTF-8 with the flag that declares
 * it, so a name outside ASCII extracts correctly.
 *
 * @param {Array<{name: string, bytes: Uint8Array}>} files The files.
 * @param {Date} date The date stamped on every entry.
 * @returns {Uint8Array} The archive's bytes.
 */
export function buildZip(files, date) {
    const encoder = new TextEncoder();
    const stamp = dosDateTime(date);
    const local = [];
    const central = [];
    let offset = 0;

    files.forEach(file => {
        const nameBytes = encoder.encode(file.name);
        const data = file.bytes;
        const crc = crc32(data);
        // Version 2.0 (20) is the floor that has the UTF-8 flag; bit 11 declares the name's encoding.
        const header = [
            ...u32(0x04034B50), ...u16(20), ...u16(0x0800), ...u16(0),
            ...u16(stamp.time), ...u16(stamp.date),
            ...u32(crc), ...u32(data.length), ...u32(data.length),
            ...u16(nameBytes.length), ...u16(0)
        ];
        local.push(Uint8Array.from(header), nameBytes, data);
        // The central copy repeats the header and adds the offset the reader seeks to. "Made by" 20 with a zero high byte says MS-DOS/FAT, the neutral choice: naming a unix creator invites readers to look for permission bits that are not there.
        central.push(Uint8Array.from([
            ...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
            ...u16(stamp.time), ...u16(stamp.date),
            ...u32(crc), ...u32(data.length), ...u32(data.length),
            ...u16(nameBytes.length), ...u16(0), ...u16(0),
            ...u16(0), ...u16(0), ...u32(0),
            ...u32(offset)
        ]), nameBytes);
        offset += header.length + nameBytes.length + data.length;
    });

    const centralSize = central.reduce((n, part) => n + part.length, 0);
    const end = Uint8Array.from([
        ...u32(0x06054B50), ...u16(0), ...u16(0),
        ...u16(files.length), ...u16(files.length),
        ...u32(centralSize), ...u32(offset), ...u16(0)
    ]);

    const parts = [...local, ...central, end];
    const total = parts.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    parts.forEach(part => { out.set(part, at); at += part.length; });
    return out;
}
