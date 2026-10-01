#!/usr/bin/env node
/**
 * Starts (or stops) a throwaway Postgres for the integration tests.
 *
 * The tests deliberately use a real database rather than a mock: they depend
 * on a unique constraint for the 409 path and on row deletion for logout
 * revocation, and neither survives being faked.
 *
 * Usage: node scripts/test-db.mjs up|down|status
 */
import { execFileSync } from "node:child_process";

const CONTAINER = "ws-chat-test-db";
const IMAGE = "postgres:16-alpine";
const PORT = process.env.TEST_DB_PORT ?? "55432";
const DB = "websocket_chat_test";
const USER = "postgres";
const PASSWORD = "test";

export const DATABASE_URL = `postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB}`;

function docker(...args) {
    return execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function hasDocker() {
    try {
        docker("info");
        return true;
    } catch {
        return false;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(container, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
        try {
            docker("exec", container, "pg_isready", "-U", USER, "-d", DB);
            return true;
        } catch {
            await sleep(1000);
        }
    }
    return false;
}

async function up() {
    if (!hasDocker()) {
        console.error("Docker is not available. Integration tests need Postgres.");
        console.error("Either start Docker, or run `npm run test:unit` for the unit suite.");
        process.exit(1);
    }

    // Reuse a healthy container if one is already up.
    try {
        docker("inspect", CONTAINER);
        const state = docker("inspect", "-f", "{{.State.Running}}", CONTAINER)
            .toString()
            .trim();
        if (state === "true") {
            console.log(`Reusing running container ${CONTAINER}`);
            console.log(DATABASE_URL);
            return;
        }
        docker("rm", "-f", CONTAINER);
    } catch {
        // Not present; fall through and create it.
    }

    console.log(`Starting ${CONTAINER} on port ${PORT}...`);
    docker(
        "run", "-d",
        "--name", CONTAINER,
        "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
        "-e", `POSTGRES_USER=${USER}`,
        "-e", `POSTGRES_DB=${DB}`,
        "-p", `${PORT}:5432`,
        IMAGE,
    );

    if (!(await waitForReady(CONTAINER))) {
        console.error("Postgres did not become ready in time.");
        process.exit(1);
    }

    console.log("Postgres ready");
    console.log(DATABASE_URL);
}

function down() {
    try {
        docker("rm", "-f", CONTAINER);
        console.log(`Removed ${CONTAINER}`);
    } catch {
        console.log("Nothing to remove");
    }
}

function status() {
    try {
        console.log(docker("inspect", "-f", "{{.State.Status}}", CONTAINER).toString().trim());
    } catch {
        console.log("not created");
    }
}

const command = process.argv[2] ?? "up";
if (command === "up") await up();
else if (command === "down") down();
else if (command === "status") status();
else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
