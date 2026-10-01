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

    scope.ChatAPI = { readJSON };
})(typeof globalThis !== "undefined" ? globalThis : this);
