import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";

import pool from "../src/db.js";
import { createChatServer, type ChatServer } from "../src/app.js";
import { DEMO_ACCOUNTS, seedDemoAccounts } from "../src/demo.js";
import { __reset as resetTickets } from "../src/utils/tickets.js";

/**
 * Integration tests: real Express app, real Postgres, real WebSocket upgrade.
 *
 * Nothing is mocked. The auth flows depend on a unique constraint (409 on a
 * duplicate username) and on row deletion (logout revoking a session), and a
 * mock would exercise neither.
 *
 * The server comes from `createChatServer` — the same factory production uses —
 * so the handshake policy under test is the policy that ships.
 *
 * Needs Postgres. `npm run test:db` starts a throwaway container.
 */

const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres:test@localhost:55432/websocket_chat_test";

const JWT_SECRET = "test-secret-not-used-anywhere-else";
const TEST_ORIGIN = "http://localhost:5500";

let server: ChatServer;

before(async () => {
    // db.ts builds its pool at import time from DATABASE_URL, so it has to be
    // set before this file's imports are evaluated. Run via `npm test`, which
    // exports it.
    if (!process.env.DATABASE_URL) {
        throw new Error(
            "DATABASE_URL is not set. Run tests via `npm test`, or set it manually.",
        );
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS active_tokens (
            id SERIAL PRIMARY KEY,
            token VARCHAR(255) UNIQUE NOT NULL,
            username VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
        )
    `);
    // Required by the login upsert; see schema.sql.
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS active_tokens_username_key
            ON active_tokens (username)
    `);

    server = createChatServer({
        jwtSecret: JWT_SECRET,
        env: { ...process.env, ALLOWED_ORIGINS: TEST_ORIGIN },
        // The real ticket limiter allows 20 requests/minute per IP. This suite
        // legitimately issues more than 20 tickets, so without lifting the cap
        // every later test would 429 and fail for the wrong reason.
        rateLimitMax: 10_000,
    });
    await server.listen(0);
});

after(async () => {
    await server?.shutdown();
    await pool.end();
});

/** Every socket opened by a test, so they can all be closed in afterEach. */
const openSockets = new Set<WebSocket>();

beforeEach(async () => {
    resetTickets();
    await pool.query("TRUNCATE active_tokens, users RESTART IDENTITY CASCADE");
});

afterEach(() => {
    // Fire-and-forget teardown. Awaiting the close handshake here deadlocks the
    // runner: the server's own close handler schedules a presence broadcast, and
    // `node:test` will not advance past a hook that waits on socket I/O. The
    // sockets are terminated synchronously, and `after()` drains the server side.
    for (const ws of openSockets) ws.terminate();
    openSockets.clear();
});

// --- helpers -------------------------------------------------------------

async function makeUser(username = "alice", password = "password123") {
    await request(server.app)
        .post("/register")
        .send({ username, password })
        .expect(201);
    return { username, password };
}

async function login(username = "alice", password = "password123"): Promise<string> {
    const res = await request(server.app)
        .post("/login")
        .send({ username, password })
        .expect(200);
    return res.body.token as string;
}

/** Full path: login -> ticket exchange. */
async function getTicket(username = "alice", password = "password123"): Promise<string> {
    const token = await login(username, password);
    const res = await request(server.app)
        .post("/ws-ticket")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
    return res.body.ticket as string;
}

const wsUrl = (query: string) => `ws://127.0.0.1:${server.port}${query}`;

/** Presence broadcasts are not chat traffic. */
const isChatMsg = (m: Record<string, unknown>): boolean =>
    m.type !== "userList" && m.type !== "announcement";

/** A socket plus every frame it has ever received. */
interface TrackedSocket {
    ws: WebSocket;
    /** Frames received so far, oldest first. */
    received: Record<string, unknown>[];
    /** Resolves with the next chat frame, including one already buffered. */
    nextChat: (timeoutMs?: number) => Promise<Record<string, unknown>>;
    close: () => void;
}

/** Creates a tracked socket so afterEach can guarantee it gets closed. */
function openSocket(url: string, options?: { origin?: string }): WebSocket {
    const ws = new WebSocket(url, options);
    openSockets.add(ws);
    ws.once("close", () => openSockets.delete(ws));
    return ws;
}

/**
 * Opens a socket and starts buffering frames immediately.
 *
 * Buffering from creation matters: the server broadcasts `userList` the instant
 * a connection opens, so a listener attached only after awaiting `open` can
 * miss that frame entirely.
 */
function connect(query: string, origin = TEST_ORIGIN): TrackedSocket {
    const ws = openSocket(wsUrl(query), { origin });
    const received: Record<string, unknown>[] = [];
    const waiters: Array<(msg: Record<string, unknown>) => void> = [];

    ws.on("message", (data: WebSocket.RawData) => {
        const parsed = JSON.parse(data.toString());
        received.push(parsed);

        // Only a chat frame may satisfy a waiter. Blindly shifting would burn a
        // waiter on the presence broadcast and silently drop the real message.
        if (!isChatMsg(parsed)) return;

        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
    });

    const nextChat = (timeoutMs = 5000) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
            const buffered = received.find(isChatMsg);
            if (buffered) return resolve(buffered);

            // A single timer, cleared on either outcome, so nothing is left
            // pending after the test finishes.
            const onFrame = (msg: Record<string, unknown>) => {
                clearTimeout(timer);
                resolve(msg);
            };
            const timer = setTimeout(() => {
                const index = waiters.indexOf(onFrame);
                if (index !== -1) waiters.splice(index, 1);
                reject(new Error("no message received"));
            }, timeoutMs);

            waiters.push(onFrame);
        });

    return { ws, received, nextChat, close: () => ws.terminate() };
}

/** Resolves on open; rejects if the handshake is refused. */
function expectOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            ws.off("open", onOpen);
            ws.off("error", onError);
            ws.off("close", onClose);
        };
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("handshake refused"));
        };
        const onClose = (code: number) => {
            cleanup();
            reject(new Error(`closed with ${code}`));
        };

        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
    });
}

function expectRefused(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        // Both the timer and the listeners must be released. A listener left
        // armed on a socket that is later terminated keeps firing after the
        // test has finished, which stalls the runner.
        const cleanup = () => {
            clearTimeout(timer);
            ws.off("open", onOpen);
            ws.off("error", onDone);
            ws.off("close", onDone);
        };
        const onDone = () => {
            cleanup();
            resolve();
        };
        const onOpen = () => {
            cleanup();
            reject(new Error("handshake unexpectedly succeeded"));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("no close/error within 5s"));
        }, 5000);

        ws.once("open", onOpen);
        ws.once("error", onDone);
        ws.once("close", onDone);
    });
}

// --- tests ---------------------------------------------------------------

describe("GET /health", () => {
    test("reports ok", async () => {
        const res = await request(server.app).get("/health").expect(200);
        assert.equal(res.body.status, "ok");
        assert.ok(res.body.timeStamp);
    });
});

describe("POST /register", () => {
    test("creates a user and returns 201", async () => {
        const res = await request(server.app)
            .post("/register")
            .send({ username: "alice", password: "password123" })
            .expect(201);

        assert.equal(res.body.username, "alice");
    });

    test("stores a bcrypt hash, never the plaintext", async () => {
        await makeUser();
        const { rows } = await pool.query(
            "SELECT password_hash FROM users WHERE username=$1",
            ["alice"],
        );

        assert.notEqual(rows[0].password_hash, "password123");
        assert.match(rows[0].password_hash, /^\$2[aby]\$/);
    });

    test("rejects a duplicate username with 409", async () => {
        await makeUser();
        const res = await request(server.app)
            .post("/register")
            .send({ username: "alice", password: "password123" })
            .expect(409);

        assert.match(res.body.message, /already exists/i);
    });

    // Regression: a missing field used to throw a TypeError and return 500.
    test("rejects a missing username with 400, not 500", async () => {
        await request(server.app)
            .post("/register")
            .send({ password: "password123" })
            .expect(400);
    });

    test("rejects non-string input with 400", async () => {
        await request(server.app)
            .post("/register")
            .send({ username: 12345, password: "password123" })
            .expect(400);

        await request(server.app)
            .post("/register")
            .send({ username: { $ne: null }, password: "password123" })
            .expect(400);
    });

    test("rejects invalid usernames", async () => {
        for (const username of ["ab", "a".repeat(51), "has space", "<script>"]) {
            await request(server.app)
                .post("/register")
                .send({ username, password: "password123" })
                .expect(400);
        }
    });

    test("rejects short passwords", async () => {
        await request(server.app)
            .post("/register")
            .send({ username: "alice", password: "12345" })
            .expect(400);
    });
});

describe("POST /login", () => {
    test("returns a token for valid credentials", async () => {
        await makeUser();
        const res = await request(server.app)
            .post("/login")
            .send({ username: "alice", password: "password123" })
            .expect(200);

        assert.ok(res.body.token);
        assert.equal(res.body.username, "alice");
    });

    test("persists the token so it can be revoked", async () => {
        await makeUser();
        const token = await login();
        const { rows } = await pool.query(
            "SELECT username FROM active_tokens WHERE token=$1",
            [token],
        );
        assert.equal(rows.length, 1);
    });

    test("rejects a wrong password with 401", async () => {
        await makeUser();
        await request(server.app)
            .post("/login")
            .send({ username: "alice", password: "wrongpassword" })
            .expect(401);
    });

    test("does not reveal whether a username exists", async () => {
        const unknown = await request(server.app)
            .post("/login")
            .send({ username: "nobody", password: "password123" })
            .expect(401);

        await makeUser();
        const wrongPassword = await request(server.app)
            .post("/login")
            .send({ username: "alice", password: "nope1234567" })
            .expect(401);

        assert.equal(unknown.body.message, wrongPassword.body.message);
    });

    test("rejects a missing body with 400, not 500", async () => {
        await request(server.app).post("/login").send({}).expect(400);
    });

    // Regression: JWTs signed in the same second for the same user were
    // byte-identical, so the second INSERT hit the UNIQUE(token) constraint and
    // login failed with a 500. Fixed with a `jti` claim plus an upsert.
    test("two logins in the same second both succeed", async () => {
        await makeUser();

        const first = await request(server.app)
            .post("/login")
            .send({ username: "alice", password: "password123" })
            .expect(200);

        const second = await request(server.app)
            .post("/login")
            .send({ username: "alice", password: "password123" })
            .expect(200);

        assert.notEqual(
            first.body.token,
            second.body.token,
            "each login must issue a distinct token",
        );
    });

    test("re-login invalidates the previous session", async () => {
        await makeUser();
        const first = await login();

        // Second login supersedes the first, so the old JWT can no longer get
        // a ticket: one active session per user.
        await login();

        await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", `Bearer ${first}`)
            .expect(401);
    });

    test("only one session row is kept per user", async () => {
        await makeUser();
        await login();
        await login();
        await login();

        const { rows } = await pool.query(
            "SELECT count(*)::int AS n FROM active_tokens WHERE username=$1",
            ["alice"],
        );
        assert.equal(rows[0].n, 1);
    });
});

describe("POST /logout", () => {
    test("revokes the token", async () => {
        await makeUser();
        const token = await login();

        await request(server.app).post("/logout").send({ token }).expect(200);

        const { rows } = await pool.query(
            "SELECT 1 FROM active_tokens WHERE token=$1",
            [token],
        );
        assert.equal(rows.length, 0);
    });

    test("a revoked token can no longer obtain a ticket", async () => {
        await makeUser();
        const token = await login();
        await request(server.app).post("/logout").send({ token }).expect(200);

        await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", `Bearer ${token}`)
            .expect(401);
    });

    test("rejects an unknown token with 401", async () => {
        await request(server.app)
            .post("/logout")
            .send({ token: "not-a-real-token" })
            .expect(401);
    });

    test("rejects a missing token with 400", async () => {
        await request(server.app).post("/logout").send({}).expect(400);
    });
});

describe("POST /ws-ticket", () => {
    test("issues a ticket for a valid token", async () => {
        await makeUser();
        const res = await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", `Bearer ${await login()}`)
            .expect(200);

        assert.match(res.body.ticket, /^[0-9a-f]{64}$/);
    });

    test("rejects a request with no Authorization header", async () => {
        await request(server.app).post("/ws-ticket").expect(401);
    });

    test("rejects a non-Bearer scheme", async () => {
        await makeUser();
        await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", await login())
            .expect(401);
    });

    test("rejects a token signed with a different secret", async () => {
        await makeUser();
        const forged = jwt.sign({ username: "alice" }, "attacker-secret");

        await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", `Bearer ${forged}`)
            .expect(401);
    });

    test("rejects a token for a user who does not exist", async () => {
        // Correctly signed, but never persisted as an active session.
        const orphan = jwt.sign({ username: "ghost" }, JWT_SECRET);

        await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", `Bearer ${orphan}`)
            .expect(401);
    });

    test("rejects garbage", async () => {
        await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", "Bearer not.a.jwt")
            .expect(401);
    });

    test("never echoes the JWT back", async () => {
        await makeUser();
        const token = await login();

        const res = await request(server.app)
            .post("/ws-ticket")
            .set("Authorization", `Bearer ${token}`)
            .expect(200);

        assert.ok(!JSON.stringify(res.body).includes(token));
    });
});

describe("WebSocket handshake", () => {
    test("accepts a valid ticket and identifies the user", async () => {
        await makeUser();
        const ticket = await getTicket();

        const conn = connect(`?ticket=${ticket}`);
        try {
            await expectOpen(conn.ws);
            await conn.nextChat(0).catch(() => undefined);

            const presence = conn.received.find((m) => m.type === "userList");
            assert.ok(presence, "expected a userList broadcast");
            assert.deepEqual(presence.users, ["alice"]);
        } finally {
            conn.close();
        }
    });

    test("rejects a connection with no ticket", async () => {
        const ws = openSocket(wsUrl(""), { origin: TEST_ORIGIN });
        try {
            await expectRefused(ws);
        } finally {
            ws.terminate();
        }
    });

    test("rejects a bogus ticket", async () => {
        const ws = openSocket(wsUrl(`?ticket=${"a".repeat(64)}`), {
            origin: TEST_ORIGIN,
        });
        try {
            await expectRefused(ws);
        } finally {
            ws.terminate();
        }
    });

    // The core property of the ticket design: a leaked log line is useless
    // once the ticket has been spent.
    test("rejects a replayed ticket", async () => {
        await makeUser();
        const ticket = await getTicket();

        const first = openSocket(wsUrl(`?ticket=${ticket}`), { origin: TEST_ORIGIN });
        await expectOpen(first);
        first.terminate();

        const second = openSocket(wsUrl(`?ticket=${ticket}`), { origin: TEST_ORIGIN });
        try {
            await expectRefused(second);
        } finally {
            second.terminate();
        }
    });

    test("rejects a disallowed origin even with a valid ticket", async () => {
        await makeUser();
        const ticket = await getTicket();

        const ws = openSocket(wsUrl(`?ticket=${ticket}`), { origin: "https://evil.example" });
        try {
            await expectRefused(ws);
        } finally {
            ws.terminate();
        }
    });

    test("a token in the URL is not accepted", async () => {
        await makeUser();
        const token = await login();

        // The old scheme must be dead, not silently still working.
        const ws = openSocket(wsUrl(`?token=${token}`), { origin: TEST_ORIGIN });
        try {
            await expectRefused(ws);
        } finally {
            ws.terminate();
        }
    });
});

describe("WebSocket messaging", () => {
    test("broadcasts a chat message to other connected clients", async () => {
        await makeUser("alice");
        await makeUser("bob");

        // Resolve both tickets before opening either socket. Awaiting inside
        // the template literal would construct the first WebSocket while the
        // second ticket request is still in flight.
        const aliceTicket = await getTicket("alice");
        const bobTicket = await getTicket("bob");

        const alice = connect(`?ticket=${aliceTicket}`);
        const bob = connect(`?ticket=${bobTicket}`);

        try {
            await Promise.all([expectOpen(alice.ws), expectOpen(bob.ws)]);
            const received = bob.nextChat();
            alice.ws.send(JSON.stringify({ type: "chat", message: "hello world" }));
            const msg = await received;
            assert.equal(msg.message, "hello world");
            assert.equal(msg.username, "alice");
        } finally {
            alice.close();
            bob.close();
        }
    });

    // Regression: the server used to HTML-encode while the client rendered via
    // textContent, so entities showed up literally on screen.
    test("does not double-encode HTML metacharacters", async () => {
        await makeUser();
        const ticket = await getTicket();
        const conn = connect(`?ticket=${ticket}`);

        try {
            await expectOpen(conn.ws);

            const received = conn.nextChat();
            conn.ws.send(
                JSON.stringify({ type: "chat", message: "<b>bold</b> & O'Neil" }),
            );

            assert.equal((await received).message, "<b>bold</b> & O'Neil");
        } finally {
            conn.close();
        }
    });

    test("drops a whitespace-only message", async () => {
        await makeUser();
        const ticket = await getTicket();
        const conn = connect(`?ticket=${ticket}`);

        try {
            await expectOpen(conn.ws);
            const before = conn.received.length;

            conn.ws.send(JSON.stringify({ type: "chat", message: "   " }));
            await new Promise((r) => setTimeout(r, 500));

            const chats = conn.received
                .slice(before)
                .filter((m) => m.type !== "userList" && m.type !== "announcement");
            assert.equal(chats.length, 0, "empty message should not be broadcast");
        } finally {
            conn.close();
        }
    });

    test("ignores an over-long message", async () => {
        await makeUser();
        const ticket = await getTicket();
        const conn = connect(`?ticket=${ticket}`);

        try {
            await expectOpen(conn.ws);
            const before = conn.received.length;

            conn.ws.send(JSON.stringify({ type: "chat", message: "a".repeat(300) }));
            await new Promise((r) => setTimeout(r, 500));

            const chats = conn.received
                .slice(before)
                .filter((m) => m.type !== "userList" && m.type !== "announcement");
            assert.equal(chats.length, 0);
        } finally {
            conn.close();
        }
    });

    test("survives malformed JSON without dropping the connection", async () => {
        await makeUser();
        const ticket = await getTicket();
        const conn = connect(`?ticket=${ticket}`);

        try {
            await expectOpen(conn.ws);

            conn.ws.send("this is not json");

            // Still usable afterwards.
            const received = conn.nextChat();
            conn.ws.send(JSON.stringify({ type: "chat", message: "still here" }));

            assert.equal((await received).message, "still here");
        } finally {
            conn.close();
        }
    });
});

/*
 * The demo accounts printed on the sign-in card.
 *
 * What is actually at stake is not "did the INSERT run" but a promise made to
 * the visitor in the browser: those two rows must exist, they must accept the
 * password the card publishes, and a deploy must never change anybody's
 * password. `beforeEach` truncates `users`, so every test starts from an empty
 * database — which is also the state a freshly created Render instance boots
 * into, and the reason seeding has to be safe on both the first and the
 * thousandth run.
 */
describe("demo accounts", () => {
    test("seeds both published accounts into an empty database", async () => {
        const report = await seedDemoAccounts(pool);

        assert.deepEqual([...report.created], ["demo", "guest"]);
        assert.deepEqual(report.verified, [], "nothing should have existed yet");
        assert.deepEqual(report.taken, [], "nothing should have been squatted yet");

        const rows = await pool.query("SELECT username FROM users ORDER BY username");
        assert.deepEqual(
            rows.rows.map((row) => row.username),
            ["demo", "guest"],
        );
    });

    test("re-running on a booted database changes nothing", async () => {
        await seedDemoAccounts(pool);
        const before = await pool.query(
            "SELECT username, password_hash FROM users ORDER BY username",
        );

        const report = await seedDemoAccounts(pool);

        assert.deepEqual(report.created, [], "a second boot must not insert");
        assert.deepEqual([...report.verified], ["demo", "guest"]);

        const after = await pool.query(
            "SELECT username, password_hash FROM users ORDER BY username",
        );
        assert.deepEqual(after.rows, before.rows);

        // bcrypt salts every hash, so an upsert would rewrite them to bytes
        // that differ for the same password. Identical bytes prove the rows
        // were not touched at all.
        assert.equal(after.rows.length, 2, "row count must not grow across boots");
    });

    test("never overwrites a name someone registered first", async () => {
        // A reviewer who signs up as `demo` before the first deploy owns that
        // name. Seeding with ON CONFLICT DO UPDATE would reset their password
        // on every restart — an account takeover triggered by a deploy — so the
        // row has to be left alone and reported instead.
        const theirs = "taken-over-credentials";

        await request(server.app)
            .post("/register")
            .send({ username: "demo", password: theirs })
            .expect(201);

        const report = await seedDemoAccounts(pool);

        assert.deepEqual(report.created, ["guest"], "guest was still free");
        assert.deepEqual(report.taken, ["demo"], "the squatted name must be reported");

        // Their password still works, and the one on the card does not.
        await request(server.app)
            .post("/login")
            .send({ username: "demo", password: theirs })
            .expect(200);
        await request(server.app)
            .post("/login")
            .send({ username: "demo", password: "demo1234" })
            .expect(401);
    });

    test("the credentials on the card actually log in", async () => {
        // The whole feature in one assertion: this is the request the browser
        // makes when someone clicks a demo row.
        await seedDemoAccounts(pool);

        for (const { username, password } of DEMO_ACCOUNTS) {
            const res = await request(server.app)
                .post("/login")
                .send({ username, password })
                .expect(200);

            assert.ok(res.body.token, `${username} logged in without a session token`);
        }
    });
});
