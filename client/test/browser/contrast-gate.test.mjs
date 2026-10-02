import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchBrowser, runGate } from "../../scripts/lib/gate.mjs";
import { score, coverage } from "../../scripts/lib/contrast.mjs";

/*
 * The contrast gate, end to end, in a real Chrome.
 *
 * What is proved here, in order of importance:
 *
 *   1. the shipped client passes — both halves, contrast and coverage;
 *   2. a page that really is below the floor makes the reporter exit 1 and
 *      name the offending pair, so a pass is not a gate that cannot fail;
 *   3. a colour-bearing rule nothing renders makes it exit 1 and name the
 *      selector, so coverage is a live check rather than a shape;
 *   4. a selector list where only one member renders does the same —
 *      `matches()` on `.a, .b` says yes for `.a`, so crediting the rule on
 *      one hit would let `.b` go unmeasured;
 *   5. a clean page exits 0, so exit 1 from any of the above means
 *      something.
 *
 * The fixtures are deliberate one-fault pages: each is otherwise clean, so
 * an assertion is about one thing only.
 *
 * These are the slow tests (five Chrome runs). client/test/*.test.mjs is
 * the fast suite; this file is `npm run test:contrast`.
 */

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(HERE, "fixtures");
const CLI = path.join(CLIENT, "scripts", "check-contrast.mjs");

/** Run the reporter the way CI does: its own process, its own Chrome. */
async function report(root) {
    try {
        const { stdout } = await exec(process.execPath, [CLI, "--root", root], { encoding: "utf8" });
        return { code: 0, out: stdout };
    } catch (error) {
        // execFile rejects on a non-zero exit with the streams attached; a
        // failure to spawn at all has no numeric code and should surface.
        if (typeof error.code !== "number") throw error;
        return { code: error.code, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

const failuresLine = (pair) =>
    `${pair.value.toFixed(2)}:1 needs ${pair.floor.toFixed(2)} ${pair.role} ${pair.fg} on ${pair.on}`;

let browser;
before(async () => {
    browser = await launchBrowser();
});
after(async () => {
    await browser?.close();
});

test("the shipped client clears both halves of the gate", { timeout: 300_000 }, async () => {
    const result = await runGate({ root: CLIENT, browser });

    assert.deepEqual(result.failures, [], "a state the sweep drove did not apply");

    const { pairs, failures } = score(result.records);
    assert.deepEqual(failures.map(failuresLine), [], "pairs below their floor");

    const cover = coverage(result.rules, result.exercised);
    assert.deepEqual(
        cover.missing.map((rule) => rule.selector),
        [],
        "colour-bearing rules the sweep never matched",
    );

    // A gate that measured nothing would also report zero failures, so the
    // size of the report is part of the claim.
    assert.ok(pairs.length > 40, `expected a real report, got ${pairs.length} pairs`);
    assert.ok(cover.total > 60, `expected a real inventory, got ${cover.total} rules`);

    // Both exemption inputs must actually be produced by the sweep, or the
    // exemption code is dead and nothing here would notice. (Whether a given
    // exempt pair lands below its floor is a separate matter, and is proved
    // by the clean fixture below.)
    assert.ok(
        result.records.some((record) => record.decorative),
        "aria-hidden elements must be measured as decorative, not skipped",
    );
    assert.ok(
        result.records.some((record) => record.inactive),
        "disabled controls must be measured as inactive, not skipped",
    );

    // The sweep must have looked at both themes and both viewport widths.
    assert.deepEqual(
        [...new Set(pairs.flatMap((pair) => [...pair.themes]))].sort(),
        ["dark", "light"],
    );
});

test("one pair below the text floor exits 1 and names it", { timeout: 120_000 }, async () => {
    const { code, out } = await report(path.join(FIXTURES, "failing"));

    assert.equal(code, 1, `expected a failing gate, got:\n${out}`);
    assert.match(out, /BELOW THE REQUIRED CONTRAST/);
    assert.match(out, /#777777 on #808080/);
    assert.match(out, /needs 4\.50\s+text/, "the text floor, not another role's");
    assert.match(out, /p\.bad/, "the report points at the element");

    // It must fail on contrast alone: this fixture has no coverage gap and
    // no state the sweep failed to drive.
    assert.ok(
        !out.includes("COLOUR-BEARING RULES THAT WERE NEVER EXERCISED"),
        `unexpected coverage gap:\n${out}`,
    );
    assert.match(out, /· 0 driving errors/);
    assert.match(out, /\bFAILED\b/);
});

test("a rule nothing renders exits 1 and names the selector", { timeout: 120_000 }, async () => {
    const { code, out } = await report(path.join(FIXTURES, "uncovered"));

    assert.equal(code, 1, `expected a failing gate, got:\n${out}`);
    assert.match(out, /COLOUR-BEARING RULES THAT WERE NEVER EXERCISED/);
    assert.match(out, /\.never-rendered/);
    assert.match(out, /sets: color, background/, "the report says what the rule sets");

    // It must fail on coverage alone: every colour here passes.
    assert.ok(
        !out.includes("BELOW THE REQUIRED CONTRAST"),
        `unexpected contrast failure:\n${out}`,
    );
    assert.match(out, /· 0 below floor ·/);
    assert.match(out, /\bFAILED\b/);
});

test("a selector list only counts when every member renders", { timeout: 120_000 }, async () => {
    const { code, out } = await report(path.join(FIXTURES, "uncovered-group"));

    assert.equal(code, 1, `expected a failing gate, got:\n${out}`);
    assert.match(out, /COLOUR-BEARING RULES THAT WERE NEVER EXERCISED/);
    // `matches()` on a comma group says yes when any member matches, so this
    // is the one that a laxer coverage check would have waved through: the
    // rendered member proves nothing about the one beside it.
    assert.match(out, /\.rendered, \.never-shown/);
    assert.match(out, /sets: background/);
    assert.match(out, /· 0 below floor ·/, "the colours are fine; only the rule went unmeasured");
});

test("a clean fixture exits 0, so exit 1 means something", { timeout: 120_000 }, async () => {
    const { code, out } = await report(path.join(FIXTURES, "clean"));

    assert.equal(code, 0, `expected a passing gate, got:\n${out}`);
    assert.match(out, /· 0 below floor ·/);
    assert.match(out, /· 0 driving errors/);
    assert.match(out, /coverage 3\/3 rules/);
    assert.match(out, /\bOK\b/);

    // The low-contrast chip is exempt, not passed: it still appears, and it
    // is counted separately from the pairs that were actually judged.
    assert.match(out, /· 1 exempt below floor/);
    assert.match(out, /aria-hidden decorative text/);
    assert.match(out, /\[decorative\]/, "the table tags the row so it does not read as a duplicate");
});
