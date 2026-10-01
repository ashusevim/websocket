import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveOrigins } from "../src/app.js";

/**
 * The allowlist used to ship a previous deployment's hostnames as defaults, so
 * the first deploy after a service was recreated silently checked the wrong
 * origins and failed as an unexplained 403 on connect. There is no default
 * list now: the value is configuration or it is an error at boot.
 */
describe("resolveOrigins", () => {
    describe("when nothing is configured", () => {
        test("throws rather than allowing nothing", () => {
            // Returning [] would boot successfully, pass the health check, and
            // then refuse every connection — the worst of both.
            assert.throws(
                () => resolveOrigins({}),
                (error: Error) => {
                    assert.match(error.message, /ALLOWED_ORIGINS is not set/);
                    // Must tell the operator what to do, not just that it failed.
                    assert.match(error.message, /ALLOWED_ORIGINS=http:\/\/localhost:5500/);
                    return true;
                },
            );
        });

        test("throws on an empty string", () => {
            assert.throws(() => resolveOrigins({ ALLOWED_ORIGINS: "" }), /ALLOWED_ORIGINS is not set/);
        });

        test("throws when only separators are present", () => {
            assert.throws(() => resolveOrigins({ ALLOWED_ORIGINS: " ,  ," }), /ALLOWED_ORIGINS is not set/);
        });
    });

    describe("valid origins", () => {
        test("accepts a single http origin", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "http://localhost:5500" }),
                ["http://localhost:5500"],
            );
        });

        test("accepts a single https origin", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com" }),
                ["https://chat.example.com"],
            );
        });

        test("splits on commas and trims each entry", () => {
            assert.deepEqual(
                resolveOrigins({
                    ALLOWED_ORIGINS: " http://localhost:5500 ,\thttps://a.example.com  ",
                }),
                ["http://localhost:5500", "https://a.example.com"],
            );
        });

        test("keeps an explicit non-default port", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "http://localhost:8080" }),
                ["http://localhost:8080"],
            );
        });

        test("drops duplicate entries", () => {
            assert.deepEqual(
                resolveOrigins({
                    ALLOWED_ORIGINS: "https://a.example.com,https://a.example.com",
                }),
                ["https://a.example.com"],
            );
        });
    });

    /*
     * Comparisons in app.ts are exact string matches against the browser's
     * Origin header, so anything that differs from what that header will be
     * cannot match — and the failure presents as a 403 on connect, not a CORS
     * error. Normalising the accepted cases and rejecting the rest is what
     * makes that failure legible.
     */
    describe("normalisation", () => {
        test("strips a trailing slash", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com/" }),
                ["https://chat.example.com"],
            );
        });

        test("lowercases the scheme and host", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "HTTPS://Chat.Example.COM" }),
                ["https://chat.example.com"],
            );
        });

        test("drops a default port", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com:443" }),
                ["https://chat.example.com"],
            );
        });

        test("keeps a non-default port after normalising", () => {
            assert.deepEqual(
                resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com:8443/" }),
                ["https://chat.example.com:8443"],
            );
        });
    });

    describe("values that can never match an Origin header", () => {
        test("rejects a path", () => {
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com/app" }),
                (error: Error) => {
                    assert.match(error.message, /bare origin/);
                    // The message must hand back the corrected value.
                    assert.match(error.message, /"https:\/\/chat\.example\.com"/);
                    return true;
                },
            );
        });

        test("rejects a query string", () => {
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com?a=1" }),
                /bare origin/,
            );
        });

        test("rejects a fragment", () => {
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "https://chat.example.com/#top" }),
                /bare origin/,
            );
        });

        test("rejects wss://, which can never be an Origin header", () => {
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "wss://api.example.com" }),
                (error: Error) => {
                    assert.match(error.message, /absolute http:\/\/ or https:\/\//);
                    assert.match(error.message, /wss:\/\/ values can never match/);
                    return true;
                },
            );
        });

        test("rejects ws://", () => {
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "ws://api.example.com" }),
                /wss:\/\/ values can never match/,
            );
        });

        test("rejects a host with no scheme", () => {
            // "localhost:5500" parses successfully with scheme "localhost:",
            // so without the protocol check this would be accepted and then
            // never match any real Origin header.
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "localhost:5500" }),
                (error: Error) => {
                    assert.match(error.message, /must be an absolute http:\/\/ or https:\/\//);
                    assert.match(error.message, /scheme parsed as "localhost:"/);
                    return true;
                },
            );
        });

        test("rejects a non-URL", () => {
            assert.throws(
                () => resolveOrigins({ ALLOWED_ORIGINS: "not a url" }),
                /is not a URL/,
            );
        });

        test("rejects one bad entry among good ones", () => {
            assert.throws(
                () =>
                    resolveOrigins({
                        ALLOWED_ORIGINS: "https://ok.example.com,https://bad.example.com/path",
                    }),
                /bare origin/,
            );
        });
    });
});
