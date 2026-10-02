import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

/**
 * Graceful shutdown, end to end, against the real entrypoint.
 *
 * index.ts owns process-level concerns and holds no other tests — everything
 * else goes through the factory in app.ts. Shutdown is the exception: the bug
 * it guards against lives in index.ts's own sequence, and it is invisible to
 * the factory, so the only honest test starts the process a platform would
 * start and signals it the way a platform would.
 *
 * The failure this pins: gracefulShutdown() used to await `server.close()`
 * before tearing down the WebSockets. `server.close()` resolves only when
 * every connection it tracks has ended, and upgraded sockets are still
 * counted by it — so with one chat open, close() waited for sockets that only
 * shutdown() could close, and shutdown() was never reached. The process hung
 * until SIGKILL, skipping the Sentry flush and the pool drain the function
 * exists to perform. With no chat open it exited cleanly, which is exactly
 * why it survived review: nothing in the suite had a client connected.
 *
 * The child seeds the demo accounts itself during boot, so this also pins
 * that seed-before-listen ordering under a real process: login must succeed
 * the moment /health answers.
 */

// Derived from the pid so a stale process on a fixed port cannot make this
// flaky. --test-concurrency=1 keeps it clear of the other suites' ports.
const PORT = 18000 + (process.pid % 1000);
const ORIGIN = "http://localhost:5500";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.resolve(here, "../src/index.js");

/** Generous next to a shutdown that normally finishes in well under a second,
 *  and still short enough that a reappeared hang fails the run rather than
 *  hanging it. */
const EXIT_TIMEOUT_MS = 12_000;

let child: ChildProcess | null = null;
let output = "";

after(() => {
    // Reached on a failed assertion before SIGTERM: an orphaned server would
    // hold the port for whatever runs next.
    if (child && child.exitCode === null) child.kill("SIGKILL");
});

async function boot(): Promise<ChildProcess> {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is not set; run this through the integration runner");
    }

    const proc = spawn(process.execPath, [ENTRYPOINT], {
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: "test",
            // No Sentry network calls from the test run.
            SENTRY_DSN: "",
            ALLOWED_ORIGINS: ORIGIN,
            // index.ts refuses to boot without one, and the suite does not
            // set it: this value exists only to satisfy this child.
            JWT_SECRET: process.env.JWT_SECRET ?? "shutdown-test-secret-0123456789abcdef",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;

    proc.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += String(chunk); });

    for (let attempt = 0; attempt < 80; attempt += 1) {
        if (proc.exitCode !== null) {
            throw new Error(`server exited with ${proc.exitCode} before booting:\n${output}`);
        }
        try {
            const res = await fetch(`http://localhost:${PORT}/health`);
            if (res.ok) return proc;
        } catch {
            /* not listening yet */
        }
        await sleep(250);
    }

    proc.kill("SIGKILL");
    throw new Error(`server did not become healthy on :${PORT}:\n${output}`);
}

test("SIGTERM with a chat open still shuts down cleanly", async () => {
    const proc = await boot();

    const login = await fetch(`http://localhost:${PORT}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "demo", password: "demo1234" }),
    });
    assert.equal(login.status, 200, `login failed before the test began:\n${output}`);
    const { token } = (await login.json()) as { token?: string };
    assert.ok(token, "login returned no token");

    const ticketRes = await fetch(`http://localhost:${PORT}/ws-ticket`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    assert.equal(ticketRes.status, 200, `ticket failed:\n${output}`);
    const { ticket } = (await ticketRes.json()) as { ticket?: string };
    assert.ok(ticket, "no ticket returned");

    // The whole point: a connection is live when the signal arrives.
    const socket = new WebSocket(
        `ws://localhost:${PORT}?ticket=${encodeURIComponent(ticket)}`,
        { headers: { Origin: ORIGIN } },
    );
    await new Promise<void>((resolve, reject) => {
        socket.on("open", resolve);
        socket.on("error", reject);
    });
    // The server terminates us mid-shutdown; without a listener an 'error'
    // here would be an unhandled event rather than a test result.
    socket.on("error", () => { /* expected once the server tears sockets down */ });

    const exited = new Promise<number | string>((resolve) => {
        proc.once("exit", (code) => resolve(code === null ? "signal" : code));
    });
    proc.kill("SIGTERM");

    const code = await Promise.race([
        exited,
        sleep(EXIT_TIMEOUT_MS).then(() => "timeout" as const),
    ]);

    assert.notEqual(
        code,
        "timeout",
        `server did not exit within ${EXIT_TIMEOUT_MS}ms of SIGTERM while a chat was ` +
            `open — shutdown is waiting on a connection only it can close.\n${output}`,
    );
    assert.equal(
        code,
        0,
        `expected a clean exit, got ${code}. The deadline path exits 1 when the ` +
            `graceful sequence does not finish:\n${output}`,
    );
    assert.match(
        output,
        /Graceful shutdown complete\./,
        `exited without reporting a completed shutdown:\n${output}`,
    );
});
