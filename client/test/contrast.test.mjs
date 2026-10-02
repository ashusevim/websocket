import test from "node:test";
import assert from "node:assert/strict";

import {
    ROLES,
    EXEMPT_REASON,
    INACTIVE_REASON,
    parseColor,
    over,
    composite,
    relativeLuminance,
    contrast,
    boundaryVisibility,
    toHex,
    score,
    coverage,
} from "../scripts/lib/contrast.mjs";

/*
 * The colour maths behind the contrast gate, on its own: no DOM, no Chrome,
 * no filesystem. check-contrast.mjs measures what the browser painted and
 * hands the serialised colours here, so every number that decides pass or
 * fail is pinned down by this file rather than by a browser run.
 */

const near = (actual, expected, tolerance = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} !~ ${expected} (±${tolerance})`);

/* ------------------------------------------------------------------ *
 * parseColor
 * ------------------------------------------------------------------ */

test("parseColor accepts the notations Chrome emits", () => {
    assert.deepEqual(parseColor("#abc"), { r: 170, g: 187, b: 204, a: 1 });
    assert.deepEqual(parseColor("#aabbcc"), { r: 170, g: 187, b: 204, a: 1 });
    assert.deepEqual(parseColor("#aabbccff"), { r: 170, g: 187, b: 204, a: 1 });
    assert.equal(parseColor("#aabbcc00").a, 0);

    // Legacy comma form: the shape getComputedStyle returns for opaque colours.
    assert.deepEqual(parseColor("rgb(10, 10, 11)"), { r: 10, g: 10, b: 11, a: 1 });
    assert.deepEqual(parseColor("rgba(227, 199, 120, 0.1)"), { r: 227, g: 199, b: 120, a: 0.1 });

    // Space-separated form, with alpha after the slash.
    assert.deepEqual(parseColor("rgb(10 10 11 / 0.5)"), { r: 10, g: 10, b: 11, a: 0.5 });

    // color-mix() resolves through color(srgb ...).
    assert.deepEqual(parseColor("color(srgb 0.7 0.13 0.09 / 0.4)"), {
        r: 0.7 * 255,
        g: 0.13 * 255,
        b: 0.09 * 255,
        a: 0.4,
    });

    assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
});

test("a percentage means half in every notation", () => {
    assert.deepEqual(parseColor("rgb(50% 0% 0% / 50%)"), { r: 127.5, g: 0, b: 0, a: 0.5 });
    // srgb's unit is 1, so scaling a percentage by the unit would give 0.5.
    assert.deepEqual(parseColor("color(srgb 50% 0% 0%)"), { r: 127.5, g: 0, b: 0, a: 1 });
});

test("an unparseable colour throws rather than becoming black", () => {
    for (const value of ["", "none", "oklab(0.5 0 0)", "currentcolor", "#12", "rgb(1, 2)"]) {
        assert.throws(() => parseColor(value), /cannot parse colour/, `expected ${JSON.stringify(value)} to throw`);
    }
});

/* ------------------------------------------------------------------ *
 * Compositing and luminance
 * ------------------------------------------------------------------ */

test("over composites source-over in sRGB", () => {
    const half = parseColor("#ffffff80");
    assert.deepEqual(over(half, parseColor("#000000")), { r: 128, g: 128, b: 128, a: 1 });
    assert.deepEqual(over(parseColor("#00000000"), parseColor("#123456")), parseColor("#123456"));
    assert.deepEqual(over(parseColor("transparent"), parseColor("transparent")), { r: 0, g: 0, b: 0, a: 0 });
});

test("composite flattens a chain innermost-first", () => {
    // The element's own background is first; ancestors follow, as painted.
    const bg = composite([parseColor("#ffffff80"), parseColor("#000000")]);
    assert.equal(toHex(bg), "#808080");
    assert.equal(composite([parseColor("#111111"), parseColor("#000000")]).r, 17);
    assert.throws(() => composite([]), /cannot parse colour/);
});

test("relative luminance hits both anchors", () => {
    near(relativeLuminance(parseColor("#ffffff")), 1);
    near(relativeLuminance(parseColor("#000000")), 0);
});

test("contrast is 21:1 at the extremes and 1:1 for identical colours", () => {
    const white = parseColor("#ffffff");
    const black = parseColor("#000000");
    near(contrast(white, black), 21);
    near(contrast(black, white), 21);
    assert.equal(contrast(white, white), 1);
    assert.equal(contrast(parseColor("#8a6d1f"), parseColor("#8a6d1f")), 1);
    // Symmetric: the order of the arguments cannot change the answer.
    near(contrast(white, black), contrast(black, white));
});

test("translucent ink is judged as it will be seen, over its own background", () => {
    const onWhite = contrast(parseColor("#00000080"), parseColor("#ffffff"));
    assert.ok(onWhite > 1 && onWhite < 21, `expected a blended ratio, got ${onWhite}`);
});

test("contrast refuses a background nobody has resolved yet", () => {
    assert.throws(() => contrast(parseColor("#000"), parseColor("#ffffff80")), /not opaque/);
});

/* ------------------------------------------------------------------ *
 * Thresholds
 * ------------------------------------------------------------------ */

test("text is held to 4.5 and never relaxed to the large-text 3:1", () => {
    assert.equal(ROLES.text.min, 4.5);
    assert.equal(ROLES.graphic.min, 3);
    assert.equal(ROLES.outline.min, 3);
    assert.equal(ROLES.border.min, 1.2);
    assert.ok(ROLES.text.min > ROLES.graphic.min, "text must not fall back to the non-text floor");
});

test("boundary visibility takes the better of the two sides", () => {
    const hairline = parseColor("#e2e2e6");
    const onWhite = contrast(hairline, parseColor("#ffffff"));
    const onF7 = contrast(hairline, parseColor("#f7f7f8"));
    const onF0 = contrast(hairline, parseColor("#f0f0f2"));
    // Lighter backdrop, larger gap against a lighter-than-it ink.
    assert.ok(onWhite > onF7 && onF7 > onF0);
    near(boundaryVisibility(hairline, parseColor("#ffffff"), parseColor("#f0f0f2")), onWhite);
    near(boundaryVisibility(hairline, parseColor("#f0f0f2"), parseColor("#ffffff")), onWhite);
    near(boundaryVisibility(hairline, parseColor("#f0f0f2"), parseColor("#f7f7f8")), onF7);
    near(boundaryVisibility(hairline, parseColor("#f0f0f2"), parseColor("#f0f0f2")), onF0);
});

test("a hairline against its own surface is invisible", () => {
    assert.equal(boundaryVisibility(parseColor("#e2e2e6"), parseColor("#e2e2e6"), parseColor("#e2e2e6")), 1);
});

test("toHex rounds channels into report form", () => {
    assert.equal(toHex({ r: 127.5, g: 0, b: 0 }), "#800000");
    assert.equal(toHex(parseColor("#aabbcc")), "#aabbcc");
});

/* ------------------------------------------------------------------ *
 * score
 * ------------------------------------------------------------------ */

/** A well-formed record: opaque chain, both exemptions off, text role. */
const record = (overrides = {}) => ({
    path: "div.demo > span.label",
    chain: ["#111111", "#000000"],
    inactive: false,
    decorative: false,
    spec: "ALL",
    role: "text",
    color: "#ffffff",
    theme: "dark",
    ...overrides,
});

// A text colour on a background one step lighter: ~1.13:1, nowhere near 4.5.
const failing = (overrides = {}) => record({ color: "#777777", chain: ["#808080"], ...overrides });

test("a passing pair is reported and not failed", () => {
    const { pairs, failures, exempted } = score([record()]);
    assert.equal(pairs.length, 1);
    assert.deepEqual(failures, []);
    assert.deepEqual(exempted, []);
    assert.ok(pairs[0].value > ROLES.text.min);
    assert.equal(pairs[0].between, null, "text is judged against one background");
});

test("a pair below its floor fails, and carries what it needs to be found", () => {
    const { failures } = score([failing()]);
    assert.equal(failures.length, 1);
    const [pair] = failures;
    assert.equal(pair.role, "text");
    assert.equal(pair.floor, 4.5);
    assert.equal(pair.fg, "#777777");
    assert.equal(pair.on, "#808080");
    assert.ok(pair.value < 4.5);
    assert.deepEqual([...pair.themes], ["dark"]);
    assert.deepEqual(pair.examples, ["div.demo > span.label"]);
});

test("aria-hidden text is exempt but still reported", () => {
    const { failures, exempted, pairs } = score([failing({ decorative: true })]);
    assert.deepEqual(failures, [], "an incidental exemption must stop the failure");
    assert.equal(exempted.length, 1);
    assert.equal(exempted[0].exempt, EXEMPT_REASON);
    // The pair stays in the report rather than disappearing.
    assert.equal(pairs.length, 1);
});

test("an inactive control is exempt but still reported", () => {
    const { failures, exempted } = score([failing({ inactive: true })]);
    assert.deepEqual(failures, []);
    assert.equal(exempted.length, 1);
    assert.equal(exempted[0].exempt, INACTIVE_REASON);
});

test("an inactive control wins the exemption over an aria-hidden one", () => {
    const { exempted } = score([failing({ inactive: true, decorative: true })]);
    assert.equal(exempted[0].exempt, INACTIVE_REASON);
});

test("exemption covers text and graphics, never borders or outlines", () => {
    for (const role of ["border", "outline"]) {
        const { failures, exempted } = score([
            failing({ role, chain: ["#777777", "#808080"], decorative: true }),
        ]);
        assert.equal(exempted.length, 0, `${role} must not be exempted`);
        assert.equal(failures.length, 1, `${role} below floor must still fail`);
    }
});

test("a judged and an exempt occurrence of the same colours are two pairs", () => {
    const { pairs } = score([failing(), failing({ decorative: true })]);
    assert.equal(pairs.length, 2);
    assert.deepEqual(pairs.map((pair) => Boolean(pair.exempt)), [false, true]);
});

test("repeated records fold into one pair with a count and examples", () => {
    const { pairs } = score([
        record(),
        record(),
        record({ path: "div.other > span" }),
        record({ path: "div.third > span" }),
        record({ path: "div.fourth > span" }),
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].count, 5);
    assert.equal(pairs[0].examples.length, 3, "the example list is capped");
    assert.ok(pairs[0].examples.includes("div.demo > span.label"));
    assert.ok(!pairs[0].examples.includes("div.fourth > span"));
});

test("the same pair seen in both themes carries both marks", () => {
    const { pairs } = score([record({ theme: "dark" }), record({ theme: "light" })]);
    assert.deepEqual([...pairs[0].themes].sort(), ["dark", "light"]);
});

test("the report groups by role and then by lowest contrast", () => {
    const { pairs } = score([
        record({ role: "border", color: "#e2e2e6", chain: ["#ffffff", "#f7f7f8"] }),
        record({ role: "text", color: "#ffffff", chain: ["#111111"] }),
        record({ role: "graphic", color: "#888888", chain: ["#808080"] }),
        record({ role: "text", color: "#eeeeee", chain: ["#111111"] }),
        record({ role: "outline", color: "#000000", chain: ["#ffffff", "#f7f7f8"] }),
    ]);
    assert.deepEqual(pairs.map((pair) => pair.role), ["text", "text", "graphic", "outline", "border"]);
    assert.ok(pairs[0].value < pairs[1].value, "lowest contrast first inside a role");
});

test("a border is judged against both sides of itself", () => {
    // Hairline over its own fill, but clearly readable against the page
    // behind it — the shape that makes 1.2 a visibility floor, not a ratio.
    const { failures, pairs } = score([
        record({ role: "border", color: "#e2e2e6", chain: ["#e2e2e6", "#ffffff"] }),
    ]);
    assert.equal(failures.length, 0, "readable against the page means visible");
    assert.ok(pairs[0].value > 1.2);
    assert.equal(pairs[0].between, "#ffffff", "the outside surface is reported too");
});

test("a focus ring is judged against the page, not the button it rings", () => {
    // Accent outline on an accent-filled button: 1:1 against itself, which is
    // not what the reader sees — the ring separates from the page behind it.
    const { failures, pairs } = score([
        record({ role: "outline", color: "#e3c778", chain: ["#e3c778", "#111113"] }),
    ]);
    assert.deepEqual(failures, []);
    assert.ok(pairs[0].value > 10, `expected the page to carry the ring, got ${pairs[0].value}`);
    assert.equal(pairs[0].between, "#111113");
});

test("an outline invisible on both sides fails", () => {
    const { failures } = score([
        record({ role: "outline", color: "#e3c778", chain: ["#e3c778", "#111113"], inactive: true }),
        record({ role: "outline", color: "#1a1a20", chain: ["#111113", "#111113"] }),
    ]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].role, "outline");
    assert.equal(failures[0].floor, 3);
});

test("an unknown role throws instead of passing with no threshold", () => {
    // Adding a role without adding its floor must break here, not silently
    // score against undefined.
    assert.throws(() => score([record({ role: "shadow" })]), TypeError);
});

test("an empty sweep reports nothing", () => {
    assert.deepEqual(score([]), { pairs: [], failures: [], exempted: [] });
});

/* ------------------------------------------------------------------ *
 * coverage
 * ------------------------------------------------------------------ */

const rules = [
    { media: [], selector: ".live", props: ["color"] },
    { media: ["(min-width: 480px)"], selector: ".never-shown", props: ["background-color"] },
    { media: [], selector: "#also-live", props: ["border-color"] },
];

test("coverage counts the rules the sweep actually exercised", () => {
    const { total, covered, missing } = coverage(rules, [0, 2]);
    assert.equal(total, 3);
    assert.equal(covered, 2);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].selector, ".never-shown");
    assert.equal(missing[0].index, 1, "the index is what runGate's exercised set holds");
});

test("coverage reports every rule when nothing was exercised", () => {
    const { covered, missing } = coverage(rules, []);
    assert.equal(covered, 0);
    assert.deepEqual(missing.map((rule) => rule.selector), [".live", ".never-shown", "#also-live"]);
});

test("coverage tolerates a rule exercised in more than one pass", () => {
    const { covered, missing } = coverage(rules, [0, 0, 2, 2, 1]);
    assert.equal(covered, 3);
    assert.deepEqual(missing, []);
});

test("coverage of an empty stylesheet is trivially complete", () => {
    assert.deepEqual(coverage([], []), { total: 0, covered: 0, missing: [] });
});
