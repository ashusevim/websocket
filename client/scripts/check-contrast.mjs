#!/usr/bin/env node
/**
 * WCAG contrast checker for the chat client's colour tokens.
 *
 * The UI skill's pre-delivery checklist requires 4.5:1 for body text and 3:1
 * for large text and UI component boundaries. Asserting those by eye is how
 * they get violated, so they are computed here instead.
 *
 * Usage: node scripts/check-contrast.mjs
 * Exits non-zero if any pair fails, so it can gate a commit.
 */

const hex = (h) => {
    const clean = h.replace('#', '').trim();
    const full = clean.length === 3
        ? clean.split('').map((c) => c + c).join('')
        : clean;
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
    ];
};

/** Relative luminance, per WCAG 2.x. */
const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
    const [l1, l2] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
};

// Palette from the ui-ux-pro-max design system generator:
// pattern "Real-Time / Operations", style "Soft UI Evolution".
//
// Two deliberate deviations from the generator's output, both computed rather
// than eyeballed (see check-contrast.mjs):
//
//  1. The generator's #6366F1 gives 4.47:1 with white text — a hair under AA.
//     #5B54E8 lands at 5.41:1, so the filled button uses that instead.
//  2. The generator suggests near-black ink on the primary. Deep indigo reads
//     better than pure black and clears the bar comfortably in both modes.
//
// The dark scale is derived from the same indigo hue so both modes stay in family.
const PALETTE = {
    light: {
        bg: '#F5F3FF',
        surface: '#FFFFFF',
        surface2: '#EBEFF9',
        border: '#E0E7FF',
        text: '#312E81',
        dim: '#475569',
        faint: '#5A6280',
        primary: '#5B54E8',
        onPrimary: '#FFFFFF',
        ring: '#5B54E8',
        success: '#047857',
        danger: '#B91C1C',
    },
    dark: {
        bg: '#08070F',
        surface: '#12102A',
        surface2: '#1B1838',
        border: '#2B2750',
        text: '#EDEAFB',
        dim: '#B3ADD6',
        faint: '#8C85B8',
        primary: '#7C79F5',
        onPrimary: '#0B0A1F',
        ring: '#A5A2FF',
        success: '#34D399',
        danger: '#FB7185',
    },
};

/** [foreground, background, minimum ratio, label] */
const PAIRS = [
    ['text', 'surface', 4.5, 'body text on card'],
    ['text', 'surface2', 4.5, 'body text on muted surface'],
    ['text', 'bg', 4.5, 'body text on page'],
    ['dim', 'surface', 4.5, 'secondary text on card'],
    ['dim', 'bg', 4.5, 'secondary text on page'],
    ['faint', 'surface', 4.5, 'meta text on card'],
    ['faint', 'surface2', 4.5, 'meta text on muted surface'],
    ['faint', 'bg', 4.5, 'meta text on page'],
    ['onPrimary', 'primary', 4.5, 'label on primary button'],
    ['primary', 'bg', 4.5, 'link text on page'],
    ['primary', 'surface', 4.5, 'link text on card'],
    ['ring', 'surface', 3, 'focus ring vs card'],
    ['ring', 'bg', 3, 'focus ring vs page'],
    ['ring', 'surface2', 3, 'focus ring vs muted surface'],
    ['success', 'surface', 4.5, 'connected status text'],
    ['danger', 'surface', 4.5, 'destructive text'],
];

/** Hairlines are decorative separators; the guideline floor for them is 1:1. */
const DECORATIVE = [['border', 'surface', 'hairline']];

let failures = 0;

for (const mode of ['light', 'dark']) {
    const p = PALETTE[mode];
    console.log(`\n${mode.toUpperCase()}`);
    console.log('-'.repeat(66));

    for (const [fg, bg, min, label] of PAIRS) {
        const value = ratio(p[fg], p[bg]);
        const pass = value >= min;
        if (!pass) failures++;
        console.log(
            `  ${pass ? 'PASS' : 'FAIL'}  ${value.toFixed(2).padStart(5)}:1  ` +
            `(min ${min.toFixed(1)})  ${label}`,
        );
    }

    for (const [fg, bg, label] of DECORATIVE) {
        const value = ratio(p[fg], p[bg]);
        console.log(
            `  info  ${value.toFixed(2).padStart(5)}:1  (n/a)     ${label}`,
        );
    }
}

console.log('\n' + '='.repeat(66));
if (failures) {
    console.error(`${failures} pair(s) below the required contrast.`);
    process.exit(1);
}
console.log('All pairs meet WCAG AA (4.5:1 text, 3:1 focus ring).');
