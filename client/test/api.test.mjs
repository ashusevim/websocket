import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Side-effect import: index.html is a classic script and reads the global, so
// api.js exports nothing. Importing it here puts ChatAPI on globalThis, which
// is the same wiring the browser gets from <script src="api.js">.
await import("../api.js");

const { readJSON, resolveServerHost, describeFailure } = globalThis.ChatAPI ?? {};
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ORIGIN = "https://socketchatapi.ashusevim.dev";

test("api.js exposes readJSON before anything uses it", () => {
    assert.equal(typeof readJSON, "function", "globalThis.ChatAPI.readJSON is missing");
});

/*
 * The original defect: Login called `response.json()` with no guard, so a 2xx
 * carrying an empty body threw
 *     SyntaxError: Unexpected end of JSON input
 * and the caller's catch rendered that parser message as the login error.
 * readJSON must swallow it and return null instead.
 */
test("empty body returns null instead of throwing", async () => {
    await assert.doesNotReject(readJSON(new Response("")));
    assert.equal(await readJSON(new Response("")), null);
});

test("HTML body returns null instead of throwing", async () => {
    const html = new Response("<!DOCTYPE html><html>Service Suspended</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
    });
    assert.equal(await readJSON(html), null);
});

test("truncated JSON returns null instead of throwing", async () => {
    // The literal shape of a body cut off mid-write.
    assert.equal(await readJSON(new Response('{"token": "abc')), null);
});

test("bare null is treated as no usable payload", async () => {
    assert.equal(await readJSON(new Response("null")), null);
});

test("a body that fails to read returns null", async () => {
    // Connection dropped mid-body: response.text() itself rejects.
    const broken = { text: () => Promise.reject(new Error("socket hang up")) };
    assert.equal(await readJSON(broken), null);
});

test("valid JSON parses", async () => {
    assert.deepEqual(await readJSON(new Response('{"token":"t1"}')), { token: "t1" });
    assert.deepEqual(await readJSON(new Response('{"ticket":"k"}')), { ticket: "k" });
});

test("valid JSON that is not an object still parses", async () => {
    assert.deepEqual(await readJSON(new Response("[1,2]")), [1, 2]);
});

/*
 * The regression gate. readJSON can only protect the app if the app uses it;
 * a single stray `response.json()` on a success path reintroduces the bug
 * silently, because nothing else would fail. Counting them is exact here —
 * index.html contains no dynamic code generation for HTTP calls — so the
 * assertion does not depend on formatting.
 */
test("index.html never calls .json() directly", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    const direct = html.match(/\.json\s*\(/g) ?? [];
    assert.equal(
        direct.length,
        0,
        `index.html has ${direct.length} direct .json() call(s). Route body reads through ChatAPI.readJSON.`,
    );
});

test("every auth path reads its body through the helper", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    // register, login (error + success), ws-ticket (error + success)
    const uses = html.match(/ChatAPI\.readJSON/g) ?? [];
    assert.ok(uses.length >= 5, `expected >= 5 ChatAPI.readJSON uses, found ${uses.length}`);
});

test("api.js is loaded before the main script", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    const apiAt = html.indexOf('<script src="api.js">');
    const mainAt = html.indexOf('<script>\n');
    assert.notEqual(apiAt, -1, "api.js is not referenced from index.html");
    assert.ok(apiAt < mainAt, "api.js must precede the inline script that reads ChatAPI");
});

/*
 * describeFailure exists because the client and the API live on different
 * hosts, and the first thing that breaks is DNS that has not propagated yet.
 * fetch rejects that with a bare "Failed to fetch", which is unreadable as a
 * login error and indistinguishable from a laptop with no wifi — whereas the
 * real fix is one line in a file the user has never opened.
 */
test("exposes describeFailure", () => {
    assert.equal(typeof describeFailure, "function", "globalThis.ChatAPI.describeFailure is missing");
});

// The three engines' actual wording for a fetch that never reached a server.
for (const wording of [
    "Failed to fetch", // Chrome, Edge
    "NetworkError when attempting to fetch resource.", // Firefox
    "A network error occurred.", // Safari, older Firefox
    "Load failed", // Safari
]) {
    test(`a fetch rejection (${JSON.stringify(wording)}) names the origin and the config file`, () => {
        const message = describeFailure(new TypeError(wording), ORIGIN);
        assert.equal(message.includes(wording), false, "raw browser wording leaked through");
        assert.ok(message.includes(ORIGIN), `expected the origin, got: ${message}`);
        assert.ok(message.includes("window.SERVER_HOST"), `expected the config pointer, got: ${message}`);
        assert.ok(message.includes("client/config.js"), `expected the file, got: ${message}`);
    });
}

test("a non-network TypeError is NOT reported as a connection failure", () => {
    // Our own code can throw TypeErrors (bad new URL / new WebSocket input).
    // Reporting those as "check SERVER_HOST" would be wrong and would hide the
    // real bug behind a config hint.
    const message = describeFailure(new TypeError("invalid URL"), ORIGIN);
    assert.equal(message, "invalid URL");
});

test("a server-side message passes through unchanged", () => {
    // Bad credentials must keep saying bad credentials.
    assert.equal(
        describeFailure(new Error("Invalid username or password"), ORIGIN),
        "Invalid username or password",
    );
});

test("an error with no message falls back to the connection wording", () => {
    const message = describeFailure(new Error(""), ORIGIN);
    assert.match(message, /Cannot reach the server/);
});

test("a thrown non-Error falls back rather than crashing", () => {
    assert.match(describeFailure("boom", ORIGIN), /Cannot reach the server/);
    assert.match(describeFailure(undefined, ORIGIN), /Cannot reach the server/);
});

/*
 * The gate. Both entry-point catches must route through the helper; if one
 * drifts back to `error.message`, the browser's "Failed to fetch" comes back
 * on exactly the path a first-time deploy uses, and no unit test fails.
 */
test("both auth entry points report failures through describeFailure", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    const uses = html.match(/ChatAPI\.describeFailure/g) ?? [];
    assert.equal(uses.length, 2, `expected 2 describeFailure uses, found ${uses.length}`);

    const loginCatch = html.slice(html.indexOf("async function Login"), html.indexOf("async function Logout"));
    assert.ok(
        loginCatch.includes("ChatAPI.describeFailure"),
        "Login's catch no longer routes through describeFailure",
    );
});

/*
 * Host resolution. config.js holds the deployed API's hostname because a
 * static site has no build step and therefore no environment variable — which
 * makes it the wrong thing to honour on a localhost page. The regression this
 * guards: with SERVER_HOST set to the production API, a local session started
 * sending its traffic to production (and to an origin ALLOWED_ORIGINS refuses)
 * instead of to localhost:8080.
 */
const PROD_PAGE = { isProduction: true, pageHost: "chat.ashusevim.dev" };
const LOCAL_PAGE = { isProduction: false, pageHost: "localhost:5500" };
const CONFIGURED = "socketchatapi.ashusevim.dev";

test("exposes resolveServerHost", () => {
    assert.equal(typeof resolveServerHost, "function", "globalThis.ChatAPI.resolveServerHost is missing");
});

test("a deployed page uses the configured API host", () => {
    assert.equal(
        resolveServerHost({ ...PROD_PAGE, configured: CONFIGURED, query: null }),
        CONFIGURED,
    );
});

test("a deployed page with no configured host falls back to same origin", () => {
    assert.equal(resolveServerHost({ ...PROD_PAGE, configured: "", query: null }), "chat.ashusevim.dev");
});

test("a non-string configured value is ignored rather than stringified", () => {
    assert.equal(resolveServerHost({ ...PROD_PAGE, configured: undefined, query: null }), "chat.ashusevim.dev");
});

test("a localhost page ignores the configured production host", () => {
    // The regression this file exists to prevent.
    assert.equal(resolveServerHost({ ...LOCAL_PAGE, configured: CONFIGURED, query: null }), "localhost:8080");
});

test("a localhost page defaults to the local API when nothing is configured", () => {
    assert.equal(resolveServerHost({ ...LOCAL_PAGE, configured: "", query: null }), "localhost:8080");
});

test("?server= wins everywhere, including over a configured host", () => {
    assert.equal(
        resolveServerHost({ ...PROD_PAGE, configured: CONFIGURED, query: "api.staging.example.com" }),
        "api.staging.example.com",
    );
    assert.equal(
        resolveServerHost({ ...LOCAL_PAGE, configured: CONFIGURED, query: "localhost:8081" }),
        "localhost:8081",
    );
});

test("a local host can still be chosen via ?server=", () => {
    // The escape hatch the localhost rule gives up: pointing a local page at a
    // remote API still works, it just has to be deliberate.
    assert.equal(
        resolveServerHost({ ...LOCAL_PAGE, configured: "", query: CONFIGURED }),
        CONFIGURED,
    );
});

test("index.html resolves the host through the helper, not inline", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    assert.equal(
        (html.match(/ChatAPI\.resolveServerHost/g) ?? []).length,
        1,
        "expected exactly one ChatAPI.resolveServerHost call",
    );
    assert.equal(
        html.includes("function resolveServerHost"),
        false,
        "index.html re-inlined host resolution; it lives in api.js so it can be tested",
    );
});
