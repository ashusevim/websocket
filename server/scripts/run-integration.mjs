#!/usr/bin/env node
/**
 * Runs the compiled integration tests with the environment they need.
 *
 * A wrapper is required because `db.ts` constructs its connection pool at
 * import time, so DATABASE_URL must be present in the environment before the
 * test module (and therefore db.ts) is evaluated. Setting it inside the test
 * file would be too late.
 */
import { spawn } from "node:child_process";

const DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres:test@localhost:55432/websocket_chat_test";

const child = spawn(
    process.execPath,
    [
        "--test",
        "--test-concurrency=1",
        "dist/test/integration.test.js",
    ],
    {
        stdio: "inherit",
        env: {
            ...process.env,
            DATABASE_URL,
            // Deterministic test output, and no Sentry network calls.
            NODE_ENV: "test",
            SENTRY_DSN: "",
        },
    },
);

child.on("exit", (code) => process.exit(code ?? 1));
