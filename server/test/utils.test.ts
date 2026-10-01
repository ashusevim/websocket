import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { sanitize } from "../src/utils/sanitize.js";
import {
    isValidUsername,
    isValidPassword,
    isValidMessage,
} from "../src/utils/validation.js";

describe("sanitize", () => {
    test("preserves HTML metacharacters as literal text", () => {
        // Regression: the server used to HTML-encode on the wire while the
        // client renders with textContent, so entities appeared literally.
        // The user typed this and must see exactly this back.
        const typed = "<b>hello</b> & O'Neil";
        assert.equal(sanitize(typed), typed);
    });

    test("does not double-encode", () => {
        assert.equal(sanitize("&lt;"), "&lt;");
        assert.equal(sanitize("&amp;"), "&amp;");
    });

    test("strips control characters but keeps tab and newline", () => {
        assert.equal(sanitize("a\u0000b"), "ab");
        assert.equal(sanitize("a\u0007b"), "ab");
        assert.equal(sanitize("a\u007Fb"), "ab");
        assert.equal(sanitize("a\tb\nc"), "a\tb\nc");
    });

    test("normalises CRLF and CR to LF", () => {
        assert.equal(sanitize("a\r\nb"), "a\nb");
        assert.equal(sanitize("a\rb"), "a\nb");
    });

    test("trims surrounding whitespace", () => {
        assert.equal(sanitize("   hi   "), "hi");
        assert.equal(sanitize("     "), "");
    });
});

describe("isValidUsername", () => {
    test("accepts alphanumeric and underscore within bounds", () => {
        assert.equal(isValidUsername("abc"), true);
        assert.equal(isValidUsername("a".repeat(50)), true);
        assert.equal(isValidUsername("user_123"), true);
    });

    test("rejects out-of-bounds length", () => {
        assert.equal(isValidUsername("ab"), false);
        assert.equal(isValidUsername("a".repeat(51)), false);
    });

    test("rejects non-alphanumeric characters", () => {
        assert.equal(isValidUsername("has space"), false);
        assert.equal(isValidUsername("<script>"), false);
        assert.equal(isValidUsername("drop;table"), false);
    });

    // Regression: these threw a TypeError on `.length`, which surfaced as a
    // 500 instead of a 400 for a malformed body.
    test("rejects non-string input without throwing", () => {
        for (const bad of [undefined, null, 123, {}, [], true, Symbol("x")]) {
            assert.equal(isValidUsername(bad), false);
        }
    });
});

describe("isValidPassword", () => {
    test("accepts 6 to 128 characters", () => {
        assert.equal(isValidPassword("123456"), true);
        assert.equal(isValidPassword("a".repeat(128)), true);
    });

    test("rejects out-of-bounds length", () => {
        assert.equal(isValidPassword("12345"), false);
        assert.equal(isValidPassword("a".repeat(129)), false);
    });

    test("rejects non-string input without throwing", () => {
        for (const bad of [undefined, null, 123456, {}, [], true]) {
            assert.equal(isValidPassword(bad), false);
        }
    });
});

describe("isValidMessage", () => {
    test("accepts 1 to 250 characters", () => {
        assert.equal(isValidMessage("hi"), true);
        assert.equal(isValidMessage("a".repeat(250)), true);
    });

    test("rejects out-of-bounds length", () => {
        assert.equal(isValidMessage(""), false);
        assert.equal(isValidMessage("a".repeat(251)), false);
    });

    test("rejects non-string input without throwing", () => {
        for (const bad of [undefined, null, 42, {}, [], true]) {
            assert.equal(isValidMessage(bad), false);
        }
    });
});

describe("chat pipeline: sanitize then validate", () => {
    // Mirrors the order in index.ts. A whitespace-only message must be
    // rejected, not broadcast as an empty bubble.
    test("whitespace-only message is rejected after trimming", () => {
        assert.equal(isValidMessage(sanitize("   ")), false);
        assert.equal(isValidMessage(sanitize("  hi  ")), true);
    });
});
