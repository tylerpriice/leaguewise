/**
 * Dominant-colour sampling for a team's logo, and the contrast work that makes the result usable
 * as a background.
 *
 * The arithmetic (histogram, luminance, the darken-until-it-passes loop, ground assignment) is pure
 * and exported. Only sampleLogoColour touches an Image and a canvas. The logo hosts answer with a
 * permissive cross-origin header, so an image can be drawn to a canvas and read back, and
 * isAllowedLogoUrl still governs every URL that is loaded.
 *
 * @module logo-colour
 */

import { isAllowedLogoUrl } from './images.js';
import { countImageRequest } from './utils.js';

/**
 * @typedef {number[]} Rgb Three channels, 0 to 255.
 */
/**
 * @typedef {Object} Ground A background colour and the lettering that reads on it.
 * @property {Rgb} rgb The background.
 * @property {'light'|'dark'} ink Which of the two inks reads on it.
 */
// The canvas is small on purpose. A 24x24 grid is plenty to find a dominant hue, and downscaling does the averaging.
const SAMPLE_SIZE = 24;

// Pixels this transparent are background, not logo; league logos are SVGs on a transparent field.
const MIN_ALPHA = 200;

// Near-white and near-black are a logo's paper and outline, not its identity. A genuinely monochrome logo falls back to the theme's black.
const WHITE_FLOOR = 236;
const BLACK_CEILING = 26;

// Greys are not an identity either. By area, one purple logo sampled as a mid grey, so low-saturation pixels are skipped. Measured on that file, the neutrals and the real colours sit far on either side of this floor.
const SATURATION_FLOOR = 0.18;

// Six buckets per channel keep a logo's shades of one colour together without merging a red with an orange.
const BUCKETS = 6;

// ==== The pure half ====

/**
 * The WCAG relative luminance of a colour.
 *
 * @param {Rgb} rgb The colour.
 * @returns {number} Luminance from 0 (black) to 1 (white).
 */
export function relativeLuminance(rgb) {
    const chan = (c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
}

/**
 * The WCAG contrast ratio between two colours.
 *
 * @param {Rgb} a One colour.
 * @param {Rgb} b The other colour.
 * @returns {number} The ratio, from 1 to 21, whichever colour is lighter.
 */
export function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Chooses which of two discs a club crest sits on, so a dark logo is not drawn on a dark disc.
 *
 * @param {?Rgb} logo The logo's sampled colour.
 * @param {?Rgb} base The disc the crest has always had.
 * @param {?Rgb} alt The inverse disc.
 * @param {number} [floor] Contrast the logo must clear against the base disc (3, the bar for a non-text object).
 * @returns {'base'|'alt'} The base disc when the logo clears the floor or an input is missing, otherwise whichever gives more contrast.
 */
export function pickCrestGround(logo, base, alt, floor = 3) {
    if (!logo || !base || !alt) return 'base';
    const onBase = contrastRatio(logo, base);
    if (onBase >= floor) return 'base';
    return contrastRatio(logo, alt) > onBase ? 'alt' : 'base';
}

/**
 * Settles a team's card ground and its lettering together. The colour stays the team's own and the
 * lettering changes, so two teams on similar hues are not darkened to the same shade.
 *
 * @param {?Rgb} rgb The team's colour.
 * @param {?Rgb} inkLight The light lettering colour.
 * @param {?Rgb} inkDark The dark lettering colour.
 * @param {number} [floor] The contrast the lettering must clear (4.5).
 * @returns {?Ground} The ground, or null when nothing reaches the floor.
 */
export function pickCardGround(rgb, inkLight, inkDark, floor = 4.5) {
    if (!rgb || !inkLight || !inkDark) return null;
    if (contrastRatio(rgb, inkLight) >= floor) return { rgb, ink: 'light' };
    if (contrastRatio(rgb, inkDark) >= floor) return { rgb, ink: 'dark' };
    const fixed = darkenUntilContrast(rgb, inkLight, floor);
    return fixed && fixed.passed ? { rgb: fixed.rgb, ink: 'light' } : null;
}

/**
 * The CIE76 colour difference between two sRGB colours, which says how far apart two grounds look.
 *
 * @param {Rgb} a One colour.
 * @param {Rgb} b The other colour.
 * @returns {number} Under about 5 reads as one colour, around 15 as clearly two.
 */
export function deltaE(a, b) {
    const lab = (rgb) => {
        const lin = (v) => { const c = v / 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
        const r = lin(rgb[0]), g = lin(rgb[1]), bl = lin(rgb[2]);
        const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
        const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
    };
    const p = lab(a), q = lab(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * Picks a ground for every team so that no two look alike. A logo's ground is used only when it is
 * at least `minDelta` from every other team's palette ground and from every logo ground already taken.
 *
 * @param {Array<{id: *, own: ?Ground, logo: ?Ground}>} entries One per team, in the board's order.
 * @param {number} [minDelta] The smallest colour difference two grounds may have (15).
 * @returns {Map<*, Ground>} The ground by team id.
 */
export function assignDistinctGrounds(entries, minDelta = 15) {
    const result = new Map();
    const taken = [];
    entries.forEach((e) => {
        if (!e.logo) return;
        const rivals = entries.filter((x) => x !== e && x.own).map((x) => x.own).concat(taken);
        if (rivals.every((o) => deltaE(o.rgb, e.logo.rgb) >= minDelta)) {
            taken.push(e.logo);
            result.set(e.id, e.logo);
        }
    });
    entries.forEach((e) => { if (!result.has(e.id) && e.own) result.set(e.id, e.own); });
    return result;
}

/**
 * Moves a colour a share of the way toward another, channel by channel, rounded to whole channels.
 *
 * @param {Rgb} rgb The colour to move.
 * @param {Rgb} target The colour to move toward.
 * @param {number} share How far to move, from 0 to 1.
 * @returns {Rgb} The blended colour.
 */
export function blendToward(rgb, target, share) {
    return rgb.map((v, i) => Math.round(v * (1 - share) + target[i] * share));
}

/**
 * Separates a settled set of grounds that a blend has pulled too close. A team keeps its colour when
 * it is at least `minDelta` from every earlier team's; otherwise it steps toward white or black until it is.
 *
 * @param {Array<{id: *, rgb: Rgb}>} entries One per team, in the board's order.
 * @param {function(Rgb): ?Ground} pick The caller's colour-to-ground rule.
 * @param {number} [minDelta] The smallest colour difference two grounds may have (15).
 * @returns {Map<*, Ground>} The ground by team id; a team whose colour `pick` refuses is left out.
 */
export function separateGrounds(entries, pick, minDelta = 15) {
    const current = entries.map(e => { const g = pick(e.rgb); return g ? { id: e.id, rgb: g.rgb, ground: g } : null; });
    // Only earlier teams need clearing; a later team clears itself against this one on its own turn.
    const ok = (c, self) => current.every((o, j) => j >= self || !o || deltaE(o.rgb, c) >= minDelta);
    current.forEach((cur, i) => {
        if (!cur || ok(cur.rgb, i)) return;
        const targets = [[255, 255, 255], [0, 0, 0]];
        for (let step = 1; step <= 25; step++) {
            const found = targets.map(t => pick(blendToward(entries[i].rgb, t, step * 0.03)))
                .filter(g => g && ok(g.rgb, i));
            if (found.length) {
                const best = found.sort((a, b) => deltaE(a.rgb, entries[i].rgb) - deltaE(b.rgb, entries[i].rgb))[0];
                current[i] = { id: cur.id, rgb: best.rgb, ground: best };
                return;
            }
        }
    });
    return new Map(current.filter(Boolean).map(c => [c.id, c.ground]));
}

/**
 * The dominant colour of an RGBA byte array, by histogram rather than mean so the answer is a shade
 * the logo actually uses. Transparent, near-white, near-black and grey pixels are skipped.
 *
 * @param {Uint8ClampedArray|number[]} data RGBA bytes.
 * @param {Object} [opts] Options.
 * @param {number} [opts.minAlpha] The least alpha a pixel needs to count.
 * @param {number} [opts.buckets] Histogram buckets per channel.
 * @returns {?Rgb} The colour, or null when nothing qualifies.
 */
export function dominantColour(data, { minAlpha = MIN_ALPHA, buckets = BUCKETS } = {}) {
    const cells = new Map();
    const step = 256 / buckets;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < minAlpha) continue;
        // Paper and outline, not identity.
        if (r >= WHITE_FLOOR && g >= WHITE_FLOOR && b >= WHITE_FLOOR) continue;
        if (r <= BLACK_CEILING && g <= BLACK_CEILING && b <= BLACK_CEILING) continue;
        // Greys, at any lightness; see SATURATION_FLOOR.
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

/**
 * Darkens a colour in small steps until text of the given colour clears a contrast floor.
 *
 * @param {?Rgb} rgb The colour to darken.
 * @param {Rgb} against The text colour it must contrast with.
 * @param {number} floor The contrast ratio to reach.
 * @param {Object} [opts] Options.
 * @param {number} [opts.step] The share of brightness removed per step.
 * @param {number} [opts.maxSteps] The most steps to take.
 * @returns {?{rgb: Rgb, steps: number, passed: boolean}} The result, or null when no colour was given.
 */
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
    // Black is the darkest it can be; if the text still fails against it, the caller degrades the team.
    const black = [0, 0, 0];
    return { rgb: black, steps: maxSteps, passed: contrastRatio(black, against) >= floor };
}

/**
 * Formats a colour as a CSS rgb() string.
 *
 * @param {?Rgb} rgb The colour.
 * @returns {?string} The string, or null when no colour was given.
 */
export function toCssRgb(rgb) {
    return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : null;
}

/**
 * Reads a CSS colour value: #rrggbb, #rgb, rgb()/rgba() or color(srgb ...).
 *
 * @param {string} value The CSS text.
 * @returns {?Rgb} The colour, or null when the text is not one of those forms.
 */
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
    // color(srgb 0.62 0.54 0.31) is what a resolved color-mix() comes back as; its channels are 0-1 floats.
    m = /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(s);
    if (m) return [Math.round(+m[1] * 255), Math.round(+m[2] * 255), Math.round(+m[3] * 255)];
    return null;
}

// ==== The impure half: one image, one canvas, one cache ====

// One sample per URL for the session, so two teams sharing a logo share it, and a null is cached too.
const sampleCache = new Map();

// Each load is a second fetch of a logo the page may already show, so it is counted in the request log.
function loadImage(url, mode) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = mode;
        img.onload = () => { countImageRequest(url, 'logo colour', true); resolve(img); };
        img.onerror = () => { countImageRequest(url, 'logo colour', false); reject(new Error(`logo load failed (${mode})`)); };
        img.src = url;
    });
}

function pixelsOf(img) {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // An SVG with no intrinsic size draws as nothing, so drawImage is given the destination rectangle.
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    // Throws on a tainted canvas; the caller catches it.
    return ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
}

/**
 * Samples the dominant colour of one logo, trying an anonymous load first and a credentialed one
 * for custom uploads. Results, null included, are cached per URL. Never throws.
 *
 * @param {string} url The logo URL; one that is not allowlisted gives null.
 * @returns {Promise<?Rgb>} The colour, or null when it cannot be had.
 */
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
            // Try the next rung; a failure here is ordinary.
        }
    }
    sampleCache.set(url, result);
    return result;
}
