#!/usr/bin/env node
/**
 * WCAG contrast checker for the chat client's colour tokens.
 *
 * Palette direction is taken from real production references in the inspo
 * archive, where six dark app sites agree: a near-black charcoal base, a
 * monochrome/high-contrast type scale, and exactly one accent that contrasts
 * in hue with the base. Linear's design system is the archetype -- it names
 * its own colour words as "monochrome, muted, high-contrast" and uses radii
 * of 0/2/4/6 rather than the large soft radii a generated palette defaults to.
 *
 * Nothing here is eyeballed. The generator palette failed its own checklist
 * last round, so every pair is computed.
 *
 * Usage: node scripts/check-contrast.mjs   (exits non-zero on failure)
 */

const hex = (h) => {
    const clean = h.replace('#', '').trim();
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
    const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

const PALETTE = {
    dark: {
        bg: '#0a0a0b',
        surface: '#111113',
        surface2: '#191920',
        surface3: '#24242e',
        text: '#f4f4f5',
        dim: '#a8a8b3',
        faint: '#86868f',
        accent: '#e3c778',
        onAccent: '#0a0a0b',
        success: '#5ee08a',
        danger: '#ff8080',
        hairline: '#2a2a33',
        hairlineStrong: '#3a3a46',
    },
    light: {
        bg: '#f7f7f8',
        surface: '#ffffff',
        surface2: '#f0f0f2',
        surface3: '#e4e4e8',
        text: '#0a0a0b',
        dim: '#54545e',
        faint: '#6b6b76',
        accent: '#8a6d1f',
        onAccent: '#fffdf5',
        success: '#146c43',
        danger: '#b42318',
        hairline: '#e2e2e6',
        hairlineStrong: '#cfcfd6',
    },
};

/** [fg, bg, minimum, label] */
const PAIRS = [
    ['text', 'surface', 4.5, 'body text on card'],
    ['text', 'surface2', 4.5, 'body text on muted surface'],
    ['text', 'bg', 4.5, 'body text on page'],
    ['dim', 'surface', 4.5, 'secondary text on card'],
    ['dim', 'bg', 4.5, 'secondary text on page'],
    ['faint', 'surface', 4.5, 'meta text on card'],
    ['faint', 'surface2', 4.5, 'meta text on muted surface'],
    ['faint', 'bg', 4.5, 'meta text on page'],
    ['onAccent', 'accent', 4.5, 'label on filled action'],
    ['accent', 'surface', 4.5, 'accent text / own-message meta on card'],
    ['accent', 'bg', 4.5, 'accent text on page'],
    ['accent', 'surface3', 3, 'accent on raised surface'],
    ['success', 'surface', 4.5, 'connected status text'],
    ['danger', 'surface', 4.5, 'destructive text'],
    ['hairline', 'surface', 1.2, 'hairline (decorative)'],
    ['hairlineStrong', 'surface', 1.2, 'hovered hairline (decorative)'],
];

let failures = 0;
for (const mode of ['dark', 'light']) {
    const p = PALETTE[mode];
    console.log(`\n${mode.toUpperCase()}`);
    console.log('-'.repeat(64));
    for (const [fg, bg, min, label] of PAIRS) {
        const v = ratio(p[fg], p[bg]);
        const pass = v >= min;
        if (!pass) failures++;
        console.log(
            `  ${pass ? 'PASS' : 'FAIL'}  ${v.toFixed(2).padStart(5)}:1  ` +
            `(min ${min.toFixed(1)})  ${label}`,
        );
    }
}

console.log('\n' + '='.repeat(64));
if (failures) {
    console.error(`${failures} pair(s) below the required contrast.`);
    process.exit(1);
}
console.log('All pairs meet WCAG AA (4.5:1 text, 3:1 for UI boundaries).');