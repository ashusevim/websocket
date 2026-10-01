import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Side-effect import: index.html is a classic script and reads the global, so
// api.js exports nothing. Importing it here puts ChatAPI on globalThis, which
// is the same wiring the browser gets from <script src="api.js">.
await import("../api.js");

const { readJSON } = globalThis.ChatAPI ?? {};
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
