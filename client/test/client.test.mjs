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

/*
 * The favicon.
 *
 * Node has no XML parser and adding one to parse a 30-line file would be a
 * worse trade than checking the two ways an SVG actually breaks in a browser:
 * a `--` inside an XML comment (legal-looking, fatal — the parser refuses the
 * whole document) and a missing or malformed root. Neither shows up as a
 * console error a reviewer would notice; the browser just renders a broken
 * image placeholder. That is exactly what happened during development.
 */
const FAVICON_PATH = path.join(CLIENT_DIR, "favicon.svg");

async function loadFavicon() {
    return readFile(FAVICON_PATH, "utf8");
}

test("index.html declares the favicon", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    const link = html.match(/<link[^>]*rel="icon"[^>]*>/);
    assert.ok(link, "index.html has no <link rel=\"icon\">; browsers fall back to a 404 /favicon.ico");
    assert.match(link[0], /href="favicon\.svg"/, "the icon link does not point at favicon.svg");
    assert.match(link[0], /type="image\/svg\+xml"/, "the icon link omits type=\"image/svg+xml\"");
    assert.ok(
        html.indexOf(link[0]) < html.indexOf("</head>"),
        "the icon link sits outside <head>",
    );
});

test("favicon.svg parses as XML", async () => {
    const svg = await loadFavicon();

    // The root element. Anything else (a stray <div>, a stray "<") and the
    // browser shows nothing at all.
    assert.match(svg.trim(), /^<svg\b/, "favicon.svg does not start with <svg");

    // Comment bodies may not contain "--": XML forbids it, and the resulting
    // parser error kills the document rather than the comment.
    const comments = svg.match(/<!--([\s\S]*?)-->/g) ?? [];
    assert.ok(comments.length > 0, "favicon.svg lost its design comment");
    for (const comment of comments) {
        const body = comment.replace(/^<!--/, "").replace(/-->$/, "");
        assert.equal(
            body.includes("--"),
            false,
            "an XML comment contains \"--\", which makes the whole file unparseable in a browser",
        );
    }

    // Every shape self-closes and both containers close. A missed "/" or a
    // stray "</g>" is otherwise invisible until the browser drops the artwork.
    for (const shape of svg.match(/<(rect|path|circle)\b[^>]*>/g) ?? []) {
        assert.ok(shape.endsWith("/>"), `shape does not self-close: ${shape.slice(0, 40)}...`);
    }
    for (const container of ["svg", "g"]) {
        assert.equal(
            (svg.match(new RegExp(`<${container}\\b`, "g")) ?? []).length,
            (svg.match(new RegExp(`</${container}>`, "g")) ?? []).length,
            `<${container}> is not balanced`,
        );
    }
    assert.match(svg, /viewBox="0 0 64 64"/, "favicon.svg is missing its 64x64 viewBox");
});

test("the favicon tile colour matches the accent token", async () => {
    // The tile has to be one fixed colour while the app has two — light and
    // dark both carry their own --accent (#8a6d1f would vanish on a dark tab
    // strip). The dark value is the brighter of the two and reads on either
    // strip, so it is the one the favicon uses, and this test fails if the
    // palette moves and nobody redraws the icon with it.
    const svg = await loadFavicon();
    const css = await readFile(path.join(CLIENT_DIR, "styles.css"), "utf8");

    const tile = svg.match(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/);
    assert.ok(tile, "favicon.svg has no filled background tile");

    const accents = css.match(/--accent:\s*(#[0-9a-fA-F]{6})/g) ?? [];
    assert.ok(accents.length >= 2, "styles.css should define --accent for both themes");
    const darkAccent = accents[0].match(/#[0-9a-fA-F]{6}/)[0];

    assert.equal(
        tile[1].toLowerCase(),
        darkAccent.toLowerCase(),
        `favicon tile ${tile[1]} drifted from the dark theme accent ${darkAccent}`,
    );
});

/*
 * Demo credentials: one promise, two files.
 *
 * The server seeds DEMO_ACCOUNTS into Postgres; the sign-in card prints a
 * copy. Nothing joins them at runtime — a static site cannot read server
 * source, and an endpoint that hands out passwords would be a worse smell than
 * the duplicate. So the duplication is pinned from this side instead: edit
 * either file alone and the suite fails rather than shipping a card that
 * cannot log in.
 */
test("the sign-in card shows exactly the credentials the server seeds", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
    const serverSource = await readFile(
        path.join(CLIENT_DIR, "..", "server", "src", "demo.ts"),
        "utf8",
    );

    const seeded = [...serverSource.matchAll(/username:\s*"([a-zA-Z0-9_]+)",\s*password:\s*"([^"]+)"/g)]
        .map((match) => ({ username: match[1], password: match[2] }));
    assert.ok(seeded.length >= 2, `DEMO_ACCOUNTS holds ${seeded.length} entries, expected >= 2`);

    const rows = [...html.matchAll(/data-demo-username="([a-zA-Z0-9_]+)"\s+data-demo-password="([^"]+)"/g)]
        .map((match) => ({ username: match[1], password: match[2] }));
    assert.deepEqual(
        rows,
        seeded,
        "client demo rows drifted from DEMO_ACCOUNTS in server/src/demo.ts",
    );

    // The card is worthless somewhere the visitor never lands.
    const loginAt = html.indexOf('id="login"');
    const registerAt = html.indexOf('id="register"');
    const panelAt = html.indexOf('class="demo-panel"');
    assert.notEqual(loginAt, -1, 'no element with id="login"');
    assert.notEqual(panelAt, -1, "index.html has no demo panel");
    assert.ok(
        loginAt < panelAt && panelAt < registerAt,
        "the demo panel is not inside the sign-in view",
    );
});

/*
 * The attributes are what the click handler reads; the spans are what a person
 * reads. Nothing forces them to agree, so a hand-edit that updates one and not
 * the other produces a card that fills in credentials it does not display.
 */
test("each demo row displays the credentials it will submit", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");

    const buttons = [...html.matchAll(
        /<button[^>]*data-demo-username="([^"]+)"[^>]*data-demo-password="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g,
    )];
    assert.equal(buttons.length, 2, `expected 2 demo rows, found ${buttons.length}`);

    for (const [, username, password, inner] of buttons) {
        assert.ok(
            inner.includes(`>${username}<`),
            `the "${username}" row does not display its username`,
        );
        assert.ok(
            inner.includes(`>${password}<`),
            `the "${username}" row does not display its password`,
        );
    }
});

/*
 * A demo row must not be a shortcut around the form. Calling Login() directly
 * would skip the submit handler's validation, loading state and error
 * rendering, and those would silently stop applying to the one path a reviewer
 * is most likely to take. requestSubmit() is the version that fires both
 * constraint validation and the submit event; form.submit() fires neither.
 */
test("a demo row submits through the form's own handler", async () => {
    const html = await readFile(path.join(CLIENT_DIR, "index.html"), "utf8");

    const start = html.indexOf("[data-demo-username]");
    assert.notEqual(start, -1, "no click handler bound to the demo rows");
    const block = html.slice(start, html.indexOf("/* ===", start));

    assert.ok(
        block.includes("loginForm.requestSubmit()"),
        "demo rows no longer go through the login form's submit handler",
    );
    assert.equal(
        /\bLogin\s*\(/.test(block),
        false,
        "demo rows call Login() directly, bypassing validation and the loading state",
    );

    // And the row they share the form with stays inert while a login is in
    // flight, so a second click cannot race the first.
    assert.ok(
        html.includes("demoButton.disabled = true"),
        "demo rows stay clickable while a login is in flight",
    );
});
