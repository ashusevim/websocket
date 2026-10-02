import { Pool } from "pg";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

/**
 * Connection pool.
 *
 * SSL handling is negotiated, not assumed. The previous version turned SSL on
 * unconditionally whenever DATABASE_URL was set (a Supabase-shaped
 * assumption), which broke any plain-Postgres deployment — including the test
 * container — with "The server does not support SSL connections".
 *
 * Rule: enable SSL when the target actually offers it, or when
 * PGSSLMODE says so. `rejectUnauthorized: false` is appropriate for managed
 * providers whose certificate the client cannot verify by a trusted chain; set
 * PGSSLROOTCERT to pin properly instead.
 */
const connectionString = process.env.DATABASE_URL;

const sslEnabled =
    process.env.PGSSLMODE === "require" ||
    process.env.PGSSLMODE === "verify-ca" ||
    process.env.PGSSLMODE === "verify-full";

const ssl = sslEnabled
    ? process.env.PGSSLROOTCERT
        ? { ca: process.env.PGSSLROOTCERT, rejectUnauthorized: true }
        : { rejectUnauthorized: false }
    : undefined;

const pool = connectionString
    ? new Pool({
        connectionString,
        // Explicit sizing rather than pg defaults. `max: 10` matches the
        // previous effective ceiling; `connectionTimeoutMillis: 0` (the pg
        // default) waits forever for a free connection, so a saturated pool
        // hangs every request instead of surfacing — 5s fails fast. Idle
        // connections past 30s are closed rather than held against the
        // managed database's connection budget.
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        ...(ssl ? { ssl } : {}),
    })
    : new Pool({
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        database: process.env.DB_NAME || "postgres",
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        ...(ssl ? { ssl } : {}),
    });

const SCHEMA_FILE = "schema.sql";

/**
 * Applies schema.sql, once, at boot.
 *
 * A fresh managed database has no tables, so the server would start, answer
 * /health with 200, and then fail every request with a 500 — a confusing
 * first-deploy experience. Every statement in the schema is idempotent
 * (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS), so this is safe to
 * run on every start and safe to run concurrently.
 *
 * This is deliberately not a migration framework. There is one schema file, it
 * is append-only in practice, and a real tool (node-pg-migrate, Prisma) would
 * be the right call the moment there is a second versioned change.
 *
 * Set AUTO_MIGRATE=false to manage the schema by hand instead.
 */
export async function applySchema(): Promise<void> {
    if (process.env.AUTO_MIGRATE === "false") {
        return;
    }

    // Resolved relative to the compiled module, so it works whether run from
    // source via tsx or from dist/ inside the container.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.resolve(here, "..", "..", SCHEMA_FILE), // dist/src -> project root
        path.resolve(here, "..", SCHEMA_FILE),
        path.resolve(process.cwd(), SCHEMA_FILE),
    ];

    for (const candidate of candidates) {
        try {
            const sql = await readFile(candidate, "utf8");
            await pool.query(sql);
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
    }

    // Not fatal in development, where a developer may have created the tables
    // by hand. In production it almost certainly means a broken image, so make
    // it loud.
    if (process.env.NODE_ENV === "production") {
        throw new Error(
            `Could not locate ${SCHEMA_FILE}. The database schema was not applied, ` +
            `so every write will fail. Searched: ${candidates.join(", ")}`,
        );
    }
}

export default pool;
