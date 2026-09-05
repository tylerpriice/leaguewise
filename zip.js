// PURE. A minimal ZIP writer, because the diagnostic panel needed to hand over several captures at once and this codebase takes no dependencies (see docs/PUBLISHING.md). Everything here is bytes in, bytes out: no DOM, no AppState, no clock, no fetches, which is what makes it unit-testable against hand-computed values rather than against itself. STORED ONLY, no compression. A deflate implementation is a few hundred lines of Huffman coding that would need its own validation, and the payloads here are JSON the browser is about to write to disk once - the archive exists to bundle several files under one save dialog, not to make them small. Method 0 is in the original spec, so every unzip tool reads it. Measured on a real capture set: the.zip is the sum of its parts plus about 100 bytes a file. The shape written is the one in APPNOTE 6.3.x that every reader accepts: a local file header and its data per entry, then a central directory repeating those headers, then an end-of-central- directory record pointing at it. No data descriptors (sizes and CRC are known before writing, since the whole payload is in hand), no zip64 (a browser download of diagnostic JSON is nowhere near 4GB), and no encryption.

// The standard CRC-32 (IEEE 802.3, polynomial 0xEDB88320 reversed) that ZIP requires. Table built once on first use rather than at module load - a 256-entry loop is cheap, but a module that computes nothing until asked stays free to import from a test that only wants one function.
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

// CRC-32 of a byte array. Verified against the two published check values every CRC-32 implementation is tested with: the empty input is 0, and "123456789" is 0xCBF43926.
export function crc32(bytes) {
    if (!crcTable) crcTable = buildCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date and time, which is what ZIP stores - two 16-bit fields, seconds in 2-second steps and the year counted from 1980. The Date is PASSED IN rather than read here, so the same input always produces the same archive: a function that called Date.now() itself could not be tested for its byte layout, and reproducibility is worth more than the convenience.
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

// Builds one stored-entry archive from [{ name, bytes }]. `date` stamps every entry, and is required for the reason dosDateTime is. Names are written as UTF-8 with the general-purpose bit 11 set, which is how a non-ASCII filename is declared in a modern zip. The names this ships with are ASCII, but a caller building one from a league or player name would otherwise produce mojibake in the extracted file rather than an error anyone would notice.
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
