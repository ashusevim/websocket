/*
 * Response body reading for the client's API calls.
 *
 * WHY A HELPER
 * ------------
 * Every call site used to call `response.json()` directly, each with its own
 * ad-hoc `.catch(() => ({}))` — and Login's success path had none. A 2xx with
 * an empty body therefore threw a raw `SyntaxError: Unexpected end of JSON
 * input`, which the caller's catch block then rendered as the login error.
 * The user saw a JSON parser message instead of anything they could act on.
 *
 * Empty and non-JSON bodies are not hypothetical. They happen whenever a
 * request reaches something that is not this API: a static host rewriting an
 * unknown path, a proxy returning 204 or an error page, or a service that is
 * suspended. The client must treat all of them the same way — as "there is no
 * usable payload here" — rather than letting a parser exception escape.
 *
 * This file deliberately works two ways:
 *   - as a classic browser script, where it attaches to globalThis.ChatAPI
 *   - as an ES module import in the tests, which assert the exact behaviour
 *     that made the original bug reachable.
 *
 * It exports nothing: index.html is a classic script, so it reads the global.
 */
(function attach(scope) {
    "use strict";

    /**
     * Reads the body as JSON, returning `null` when there is nothing usable.
     *
     * Never rejects for payload reasons. A network failure still propagates,
     * because that is a different problem with a different message; only a
     * body that is empty, truncated, or not JSON comes back as `null`.
     *
     * @param {Response} response
     * @returns {Promise<object|null>} parsed body, or null
     */
    async function readJSON(response) {
        let text;
        try {
            text = await response.text();
        } catch {
            // The connection died mid-body. Same outcome for the caller as an
            // empty body: there is no payload to act on.
            return null;
        }

        if (!text) return null;

        try {
            const parsed = JSON.parse(text);
            // `null` is valid JSON but useless to every caller, so collapse it
            // with the failure case rather than making each one check twice.
            return parsed === null ? null : parsed;
        } catch {
            // HTML error pages, proxy notices, truncated responses.
            return null;
        }
    }

    /**
     * Decides which host the client talks to.
     *
     * Order:
     *   1. `?server=` query — always wins, so one page can be pointed at a
     *      different API without editing anything
     *   2. `window.SERVER_HOST`, but only when the page itself is deployed
     *   3. localhost, for a local development session
     *   4. the page's own host
     *
     * Condition 2 is the whole reason this is a function. `config.js` carries
     * the *deployed* API's hostname, because a static site has no build step
     * and therefore no environment variable. Honouring it on a localhost page
     * would send development traffic to production — and to an origin the
     * server's ALLOWED_ORIGINS list refuses, so it fails twice over. A local
     * session reaches a remote API deliberately, via `?server=`.
     *
     * @param {object} input
     * @param {string|null} input.query        the `server` query parameter
     * @param {string} input.configured        window.SERVER_HOST
     * @param {boolean} input.isProduction     page is not on localhost
     * @param {string} input.pageHost          location.host of the page
     * @param {string} [input.localHost]       dev API host, `localhost:8080`
     * @returns {string} host, without a scheme
     */
    function resolveServerHost({ query, configured, isProduction, pageHost, localHost = "localhost:8080" }) {
        if (query) return query;
        if (!isProduction) return localHost;
        if (typeof configured === "string" && configured) return configured;
        return pageHost;
    }

    /**
     * fetch with a deadline.
     *
     * The API lives on a free-tier instance that sleeps after idle: the first
     * request after a sleep takes 30-60s while it wakes, and a dead connection
     * hangs forever. Without a timeout the sign-in button spins indefinitely
     * on both. 10s fails fast enough to retry (the wake takes longer than any
     * healthy response) while never firing on a normal call.
     *
     * A timeout surfaces as an Error naming the deadline, not an AbortError:
     * describeFailure passes unknown Errors through verbatim, so the user
     * would otherwise read "This operation was aborted".
     *
     * @param {string} url
     * @param {object} [options] fetch options (no signal: the deadline owns it)
     * @param {number} [timeoutMs]
     * @returns {Promise<Response>}
     */
    async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        // Node only: a pending deadline must never hold the test runner open.
        if (typeof timer === "object" && typeof timer.unref === "function") {
            timer.unref();
        }
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } catch (error) {
            if (timedOut) throw new Error(`Request timed out after ${timeoutMs}ms`);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Rejections `fetch` produces when nothing was ever reached.
     *
     * These are the strings the three engines emit for a network or CORS
     * failure on `fetch`. Matching them (rather than trusting `instanceof
     * TypeError` alone) matters: a `TypeError` thrown by our own code — an
     * invalid `new URL(...)`, a bad `new WebSocket(...)` — would otherwise be
     * reported to the user as "cannot reach the API", which is both wrong and
     * a good way to hide a real bug behind a config hint.
     *
     * An unrecognised wording falls through to the caller's raw message, which
     * is exactly the behaviour this replaced. Degrading to the old message is
     * harmless; swallowing a genuine error is not.
     */
    const NETWORK_FAILURE_PATTERNS = [
        /failed to fetch/i, // Chrome, Edge
        /networkerror/i, // Firefox
        /network error/i, // Safari, older Firefox
        /load failed/i, // Safari
    ];

    function isNetworkFailure(error) {
        if (typeof TypeError === "undefined" || !(error instanceof TypeError)) {
            return false;
        }
        const message = typeof error.message === "string" ? error.message : "";
        return NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
    }

    /**
     * Builds the message for a request that never reached anything.
     *
     * `fetch` rejects a network failure with a bare `Failed to fetch`, which
     * the login form used to show verbatim. That tells the user nothing: they
     * cannot tell a mis-set `window.SERVER_HOST` from an offline laptop, and
     * the former is a one-line fix in a file they have never opened — the
     * usual case the first time a client and API live on different hosts.
     *
     * Non-network errors pass through untouched, so "Invalid username or
     * password" keeps its wording.
     *
     * @param {unknown} error  the rejection from the failing call
     * @param {string} origin  what the client tried to reach, e.g. `https://x`
     * @returns {string} a message safe to render to the user
     */
    function describeFailure(error, origin) {
        if (isNetworkFailure(error)) {
            return (
                `Cannot reach the API at ${origin}. `
                + "Check window.SERVER_HOST in client/config.js, and that the API "
                + "service is running."
            );
        }
        if (
            error
            && typeof error === "object"
            && typeof error.message === "string"
            && error.message
        ) {
            return error.message;
        }
        return "Cannot reach the server. Check your connection.";
    }

    scope.ChatAPI = { readJSON, resolveServerHost, describeFailure, fetchWithTimeout };
})(typeof globalThis !== "undefined" ? globalThis : this);
