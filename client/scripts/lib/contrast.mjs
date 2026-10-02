/**
 * Colour maths for the contrast gate.
 *
 * Everything here is pure: no DOM, no filesystem, no Chrome. The gate in
 * ./gate.mjs measures what the browser actually painted and hands the raw
 * serialised colours to these functions, so the arithmetic that decides pass
 * or fail lives in one place and is unit-tested on its own (see
 * client/test/contrast.test.mjs) without paying for a browser launch.
 *
 * The maths is WCAG 2.x SC 1.4.3 / 1.4.11:
 *   contrast = (L_lighter + 0.05) / (L_darker + 0.05)
 * with L the relative luminance of sRGB channels after the 2.4-gamma decode.
 * White on black is therefore 21:1 and identical colours are 1:1, which are
 * the two anchors the unit tests use.
 */

/**
 * Thresholds, by the role the ink plays. One table, because "is this allowed
 * to ship" must not be scattered across call sites.
 *
 *   text     4.5  SC 1.4.3 AA for normal text. Deliberately not relaxed to
 *                 3:1 for large text: nothing in this client is large, and a
 *                 uniform bar means a font-size change cannot silently drop
 *                 a heading out of the check.
 *   graphic  3.0  SC 1.4.11 — icons and other meaningful graphics (the theme
 *                 toggle, the password eye, the empty-state mark).
 *   outline  3.0  SC 1.4.11 / 2.4.11 — a focus ring has to separate from the
 *                 surface it is drawn over.
 *   border   1.2  Not a WCAG number. A 1px hairline is decorative, so it is
 *                 held to a *visibility* floor rather than 3:1: it must
 *                 separate from at least one of the two surfaces it sits
 *                 between, which is the check that would have caught a
 *                 border painted in its own background colour.
 */
export const ROLES = {
    text: { min: 4.5, note: 'SC 1.4.3 AA text' },
    graphic: { min: 3, note: 'SC 1.4.11 non-text' },
    outline: { min: 3, note: 'SC 1.4.11 focus ring' },
    border: { min: 1.2, note: 'decorative boundary visibility' },
};

/**
 * Text that is not exposed to assistive technology is "incidental" under the
 * SC 1.4.3 exceptions and carries no contrast requirement — the avatar
 * initials are aria-hidden and the sender's name is printed beside them in
 * full, so a low-contrast chip is not hiding information.
 *
 * The gate still measures these and reports them; it just does not fail on
 * them. Exempt pairs are printed in their own section so the exemption is a
 * visible decision rather than a silent gap.
 */
export const EXEMPT_REASON = 'aria-hidden decorative text (SC 1.4.3 incidental)';

/** Inactive controls are the other SC 1.4.3 exception. */
export const INACTIVE_REASON = 'inactive UI component (SC 1.4.3)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fail(message) {
    throw new Error(`contrast: cannot parse colour ${JSON.stringify(message)}`);
}

/**
 * Parse a serialised CSS colour into `{r,g,b,a}`, channels 0-255 and alpha
 * 0-1.
 *
 * Chrome hands back the modern space-separated form (`rgb(10 10 11 / 0.5)`)
 * for anything with alpha and the legacy comma form for opaque colours, and
 * `color-mix()` results can arrive as `color(srgb ...)`, so all three shapes
 * are accepted. Anything else throws rather than silently becoming black:
 * an unparsed colour would compute a real-looking ratio for a value nobody
 * chose.
 */
export function parseColor(value) {
    const raw = String(value).trim();
    if (raw === '' || raw === 'none') fail(raw);
    if (raw.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

    const hex = raw.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hex) {
        const digits = hex[1].length <= 4
            ? hex[1].split('').map((c) => c + c).join('')
            : hex[1];
        const full = digits.length === 6 ? `${digits}ff` : digits;
        return {
            r: parseInt(full.slice(0, 2), 16),
            g: parseInt(full.slice(2, 4), 16),
            b: parseInt(full.slice(4, 6), 16),
            a: parseInt(full.slice(6, 8), 16) / 255,
        };
    }

    const rgb = raw.match(/^rgba?\(([^)]*)\)$/i);
    if (rgb) return readRgb(rgb[1], 255);

    const srgb = raw.match(/^color\(\s*srgb\s+([^)]*)\)$/i);
    if (srgb) return readRgb(srgb[1], 1);

    fail(raw);
    return undefined; // unreachable; keeps the shape obvious to readers
}

/** Split a functional colour's arguments and scale its channels. */
function readRgb(inner, unit) {
    let alphaText = null;
    let body = inner;
    if (body.includes('/')) {
        const [colors, alpha] = body.split('/');
        body = colors;
        alphaText = alpha;
    }
    const parts = (body.includes(',') ? body.split(',') : body.split(/\s+/))
        .map((p) => p.trim())
        .filter(Boolean);
    if (alphaText === null && parts.length === 4) alphaText = parts.pop();
    if (parts.length !== 3) fail(`rgb(${inner})`);

    const channel = (token) => {
        const text = token.trim();
        const number = Number.parseFloat(text);
        if (Number.isNaN(number)) fail(`rgb(${inner})`);
        // A percentage is a share of the range in both notations: `rgb(50%)`
        // and `color(srgb 50%)` both mean half, so it always scales to 255.
        // Scaling it by `unit` would land on 0.5 for `srgb`, whose unit is 1.
        if (text.endsWith('%')) return clamp((number / 100) * 255, 0, 255);
        if (unit === 1) return clamp(number, 0, 1) * 255;
        return clamp(number, 0, 255);
    };

    let alpha = 1;
    if (alphaText !== null && alphaText.trim() !== '') {
        const text = alphaText.trim();
        const number = Number.parseFloat(text);
        if (Number.isNaN(number)) fail(`rgb(${inner})`);
        alpha = text.endsWith('%') ? number / 100 : number;
    }

    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: clamp(alpha, 0, 1) };
}

/** Source-over compositing, in the sRGB space CSS composites in. */
export function over(fg, bg) {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
    };
}

/**
 * Flatten a background stack into the one colour a viewer actually sees.
 *
 * `chain` is innermost-first — the element's own background first, then each
 * ancestor — which is the order the browser paints in. A chain whose result
 * is still translucent means the page has no opaque backdrop anywhere, and
 * the caller is expected to report that rather than guess a colour to judge
 * against.
 */
export function composite(chain) {
    if (chain.length === 0) fail('empty background chain');
    return chain.reduce((acc, next) => over(acc, next));
}

export function relativeLuminance({ r, g, b }) {
    const [sr, sg, sb] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
}

/**
 * Contrast ratio between two opaque colours. The foreground is composited
 * over the background first when it carries alpha, which is what happens to
 * translucent text; the background must already be opaque.
 */
export function contrast(fg, bg) {
    if (bg.a < 1) fail(`background is not opaque (alpha ${bg.a})`);
    const top = fg.a < 1 ? over(fg, bg) : fg;
    const [hi, lo] = [relativeLuminance(top), relativeLuminance(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * A boundary is visible if it separates from either side of it, so a border
 * is judged against the better of the two adjacent surfaces rather than the
 * worse one. That is the difference between "this hairline is invisible"
 * (it matches both sides) and "this hairline sits on a same-colour fill but
 * still reads against the page behind it", which is how every card in this
 * client is built.
 */
export function boundaryVisibility(borderColor, inside, outside) {
    return Math.max(contrast(borderColor, inside), contrast(borderColor, outside));
}

/** Compact `#rrggbb` form for report lines. */
export function toHex({ r, g, b }) {
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Turn raw measurement records into unique pairs and decide each one.
 *
 * Records arrive per element per phase — the same pair shows up dozens of
 * times across themes, viewports and states — so they are folded on
 * (role, foreground, background, floor, exemption). What survives is one row
 * per genuinely distinct colour decision, with the elements that produced it
 * attached, which is what makes a failure report readable: not "41 elements
 * failed" but "this colour on that colour failed, and here is where it
 * occurs".
 *
 * Exemptions do not remove a pair from the report, they move it to its own
 * list. A pair nobody can see is printed anyway, because the alternative is
 * a gate that quietly disagrees with itself about what it checked.
 */
export function score(records) {
    const pairs = new Map();

    for (const record of records) {
        const stack = record.chain.map(parseColor);
        const background = composite(stack);
        const foreground = parseColor(record.color);

        let value;
        let between = null;
        // A border and an outline are both painted at the element's edge: the
        // outline sits just outside the border box, so it abuts the element's
        // own background on one side and whatever contains it on the other.
        // Judging either against a single background is what made the focus
        // ring read as 1.00:1 — same accent on the same accent, measured
        // against the button it rings instead of the page around it.
        if (record.role === 'border' || record.role === 'outline') {
            const outside = composite(stack.slice(1));
            value = boundaryVisibility(foreground, background, outside);
            between = toHex(outside);
        } else {
            value = contrast(foreground, background);
        }

        const floor = ROLES[record.role].min;
        let exempt = null;
        if (record.role === 'text' || record.role === 'graphic') {
            if (record.inactive) exempt = INACTIVE_REASON;
            else if (record.decorative) exempt = EXEMPT_REASON;
        }

        const fg = toHex(foreground);
        const on = toHex(background);
        const key = [record.role, fg, on, between ?? '', floor, exempt ?? ''].join('|');
        let pair = pairs.get(key);
        if (!pair) {
            pair = {
                role: record.role,
                floor,
                fg,
                on,
                between,
                exempt,
                value,
                themes: new Set(),
                count: 0,
                examples: [],
            };
            pairs.set(key, pair);
        }
        pair.value = Math.min(pair.value, value);
        pair.themes.add(record.theme);
        pair.count += 1;
        if (pair.examples.length < 3 && !pair.examples.includes(record.path)) {
            pair.examples.push(record.path);
        }
    }

    // Grouped by role so the report reads as four tables rather than one
    // interleaved list, and lowest contrast first inside each.
    const order = Object.keys(ROLES);
    const all = [...pairs.values()].sort(
        (a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.value - b.value,
    );
    const byValue = (a, b) => a.value - b.value;
    return {
        pairs: all,
        failures: all.filter((pair) => !pair.exempt && pair.value < pair.floor - 1e-9).sort(byValue),
        exempted: all.filter((pair) => pair.exempt && pair.value < pair.floor - 1e-9).sort(byValue),
    };
}

/**
 * The completeness half of the gate. `exercised` is the set of inventory
 * indices the sweep fully credited — every selector in the rule matched a
 * rendered element at some point during it — and this reports anything else.
 *
 * Without this, the measurement above could be perfectly correct and still
 * miss a rule: one that only fires in a state nobody drove, on a class the
 * app stopped rendering, in a media query the sweep never entered, or the
 * half of a selector list that never rendered. Coverage turns "did we check
 * everything" from a judgement call into a count. (Which members a rule has
 * and which were seen is settled by gate.mjs, since only the sweep can know.)
 */
export function coverage(rules, exercised) {
    const seen = new Set(exercised);
    const missing = rules
        .map((rule, index) => ({ ...rule, index }))
        .filter((rule) => !seen.has(rule.index));
    return { total: rules.length, covered: rules.length - missing.length, missing };
}
