// Dominant-colour sampling for a fantasy team's logo, and the contrast work that makes the result usable as a background. PURITY SPLIT, deliberately. Everything that is arithmetic - the histogram, the luminance, the darken-until-it-passes loop - is a pure exported function with tests over synthetic pixel data (tests/features.test.js). Only sampleLogoColour touches an Image and a canvas, and it is the one function the suite cannot run. WHY THIS IS SAFE TO DO AT ALL: see docs/DATA-SOURCES.md section 13, where the CORS question was settled live before any of this was written. g.espncdn.com and a.espncdn.com answer Access-Control-Allow-Origin: *, so an anonymous image can be drawn to a canvas and read back. mystique-api.fantasy.espn.com refuses anonymous requests with a 401 and allows credentialed ones, which is why the ladder below has a second rung. No new hosts: isAllowedLogoUrl still governs every URL that is ever loaded.

import { isAllowedLogoUrl } from './images.js';

// The canvas the logo is drawn into. Small on purpose - a 24x24 grid is 576 samples, which is far more than enough to find a dominant hue and costs nothing to walk, and downscaling does the averaging that a full-size histogram would have to do itself.
const SAMPLE_SIZE = 24;

// Pixels this transparent are background rather than logo. ESPN's league logos are SVGs on a transparent field (DATA-SOURCES section 13), so without this the "dominant colour" of most of them is whatever the canvas was cleared to.
const MIN_ALPHA = 200;

// Near-white and near-black are almost always the logo's paper and its outline rather than its identity, and a wall dyed in them is a wall that looks broken. A logo that is GENUINELY monochrome falls through the histogram with nothing left and degrades to theme black, which is the same look a team with no logo already has.
const WHITE_FLOOR = 236;
const BLACK_CEILING = 26;

// NEUTRALS ARE NOT AN IDENTITY EITHER, and finding that out is the whole of item 1. The owner reported a purple-logo team hanging a black pennant. The suspected cause was a refused host; it was not. That logo is on g.espncdn.com, is fully allowlisted, answers CORS, and SAMPLED SUCCESSFULLY on the first rung - to rgb(82, 82, 82), a mid grey. The file really does contain the purple (#7855a3, #562c87, #351d54) and also a lot of grey (#d2d3d3, #a3a5a5, #494949, #cccccd), and the greys cover more AREA. A by-area histogram is therefore right and useless at the same time: it answers "which colour is there most of" when the question is "which colour is this team". So greys join paper and outline as things a logo is made OF rather than known BY. Measured on that file: every neutral in it sits at or below 0.012 saturation and every real colour at or above 0.479, so the floor separates them with two orders of magnitude to spare and is not a tuned value. A genuinely monochrome logo now falls through to nothing, which is correct - that team has no colour to be dyed with, and the ladder's later rungs exist for exactly that.
const SATURATION_FLOOR = 0.18;

// Buckets per channel. 6 gives 216 cells, which groups a logo's shades of one colour together without merging two genuinely different ones - the failure at 4 buckets was a red and an orange landing in the same cell.
const BUCKETS = 6;

// ==== The pure half ====

export function relativeLuminance(rgb) {
    const chan = (c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
}

export function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

// The dominant colour of an RGBA byte array, or null when nothing in it qualifies. Histogram rather than a mean: averaging a two-colour logo gives the colour halfway between them, which is a colour the logo does not contain. Bucketing and then averaging only the winning bucket's real pixels keeps the answer to a shade the logo actually uses.
export function dominantColour(data, { minAlpha = MIN_ALPHA, buckets = BUCKETS } = {}) {
    const cells = new Map();
    const step = 256 / buckets;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < minAlpha) continue;
        // Paper and outline, not identity.
        if (r >= WHITE_FLOOR && g >= WHITE_FLOOR && b >= WHITE_FLOOR) continue;
        if (r <= BLACK_CEILING && g <= BLACK_CEILING && b <= BLACK_CEILING) continue;
        // Greys, at any lightness - see SATURATION_FLOOR.
        const mx = Math.max(r, g, b);
        if (mx === 0 || (mx - Math.min(r, g, b)) / mx < SATURATION_FLOOR) continue;
        const key = `${Math.floor(r / step)},${Math.floor(g / step)},${Math.floor(b / step)}`;
        const cell = cells.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        cell.n += 1; cell.r += r; cell.g += g; cell.b += b;
        cells.set(key, cell);
    }
    let best = null;
    cells.forEach(cell => { if (!best || cell.n > best.n) best = cell; });
    if (!best) return null;
    return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

// Darken a sampled colour until the gold type on it clears the floor, and say how far it had to go. MEASURED, NOT EYEBALLED, which is the discipline set when the brass plate's own figures came out at 2.2:1. A team's colour is whatever it is - a bright yellow logo would otherwise put gold on gold - so the sample is scaled toward black in small steps until the pair passes, and the caller gets back both the colour it can use and whether it ran out of room.
export function darkenUntilContrast(rgb, against, floor, { step = 0.06, maxSteps = 16 } = {}) {
    if (!rgb) return null;
    let scale = 1;
    for (let i = 0; i <= maxSteps; i += 1) {
        const candidate = [
            Math.round(rgb[0] * scale),
            Math.round(rgb[1] * scale),
            Math.round(rgb[2] * scale)
        ];
        if (contrastRatio(candidate, against) >= floor) {
            return { rgb: candidate, steps: i, passed: true };
        }
        scale = Math.max(0, scale - step);
    }
    // Ran out of room. Black is the darkest it can be, and if the type still fails against black then the type is the problem rather than the sample - the caller degrades the team instead.
    const black = [0, 0, 0];
    return { rgb: black, steps: maxSteps, passed: contrastRatio(black, against) >= floor };
}

export function toCssRgb(rgb) {
    return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : null;
}

export function parseCssColour(value) {
    const s = String(value || '').trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
        const h = m[1];
        return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    // color(srgb 0.62 0.54 0.31) - what a resolved color-mix() comes back as, and --brass is one. Channels are 0-1 floats here, not bytes.
    m = /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(s);
    if (m) return [Math.round(+m[1] * 255), Math.round(+m[2] * 255), Math.round(+m[3] * 255)];
    return null;
}

// ==== The impure half: one image, one canvas, one cache ====

// Per team for the session, as the entry requires. Keyed by URL rather than by team id so two teams sharing a logo pack image share the sample, and a null result is cached too - a logo that cannot be sampled will not be retried on every render of the wall.
const sampleCache = new Map();

function loadImage(url, mode) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = mode;
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`logo load failed (${mode})`));
        img.src = url;
    });
}

function pixelsOf(img) {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // An SVG with no intrinsic size draws as nothing; giving drawImage the destination rectangle makes it scale to fit whatever the source turns out to be.
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    // Throws on a tainted canvas, which is the whole reason section 13 exists. Caught by the caller.
    return ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
}

// The sampled colour for one logo, or null when it cannot be had. Never throws. THE LADDER, and each rung is there because of a measured answer rather than a guess: anonymous - covers every espncdn logo, which answer Access-Control-Allow-Origin: * use-credentials - covers mystique's custom uploads, which 401 an anonymous request and allow credentialed ones. Only attempted for an allowlisted espn.com host. null - the team keeps theme black, which is what a logo-less team already looks like
export async function sampleLogoColour(url) {
    if (!isAllowedLogoUrl(url)) return null;
    if (sampleCache.has(url)) return sampleCache.get(url);

    let result = null;
    for (const mode of ['anonymous', 'use-credentials']) {
        try {
            const img = await loadImage(url, mode);
            result = dominantColour(pixelsOf(img));
            if (result) break;
        } catch {
            // Try the next rung; a failure here is ordinary rather than exceptional.
        }
    }
    sampleCache.set(url, result);
    return result;
}

export function resetLogoColourCache() {
    sampleCache.clear();
}
