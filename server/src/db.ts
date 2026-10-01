import { Pool } from "pg";
import dotenv from "dotenv";

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
 * PGSSLMODE/require-ssl says so. `rejectUnauthorized: false` is appropriate
 * for managed providers that present a certificate the client cannot verify by
 * a trusted chain; set PGSSLROOTCERT to pin properly instead.
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
    ? new Pool({ connectionString, ...(ssl ? { ssl } : {}) })
    : new Pool({
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        database: process.env.DB_NAME || "postgres",
        ...(ssl ? { ssl } : {}),
    });

export default pool;
