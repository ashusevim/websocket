import bcrypt from "bcrypt";
import type { Pool } from "pg";

/**
 * Credentials published on the sign-in screen so a reviewer can start talking
 * to somebody without registering first.
 *
 * They are seeded at boot rather than documented by hand, because a README
 * that promises two accounts is a promise about the database — and a promise
 * nobody checks is the kind that quietly stops being true the first time the
 * database is recreated.
 *
 * Same cost as /register, so the rows are indistinguishable from a registered
 * account: no separate table, no flag, nothing for an attacker to query.
 */
export const DEMO_ACCOUNTS = [
    { username: "demo", password: "demo1234" },
    { username: "guest", password: "guest1234" },
] as const;

export interface SeedReport {
    /** Rows this run inserted. */
    created: string[];
    /** Rows that already existed and still accept the published password. */
    verified: string[];
    /**
     * Names that were registered by someone else before the seeder ran. Left
     * untouched, but the sign-in card now advertises a password that will not
     * work for them — the caller is expected to say so in the log.
     */
    taken: string[];
}

/**
 * Idempotent: safe to run on every boot, on an empty database or a busy one.
 *
 * The one thing this will never do is overwrite an existing hash. Seeding with
 * `ON CONFLICT DO UPDATE` would reset the password of whoever registered
 * `demo` first — an account takeover that fires on every deploy. The cost of
 * that restraint is that a squatted name makes the published card wrong, so
 * that case is reported instead of silently ignored.
 */
export async function seedDemoAccounts(db: Pool): Promise<SeedReport> {
    const report: SeedReport = { created: [], verified: [], taken: [] };

    for (const { username, password } of DEMO_ACCOUNTS) {
        const hash = await bcrypt.hash(password, 10);

        const result = await db.query(
            `INSERT INTO users (username, password_hash)
             VALUES ($1, $2)
             ON CONFLICT (username) DO NOTHING`,
            [username, hash],
        );

        // 0 rows means the name was taken, which is the only case where the
        // published password can be wrong — so it is the only case worth
        // checking. A row this run inserted is correct by construction.
        if (result.rowCount && result.rowCount > 0) {
            report.created.push(username);
            continue;
        }

        const existing = await db.query(
            "SELECT password_hash FROM users WHERE username = $1",
            [username],
        );
        const stored: unknown = existing.rows[0]?.password_hash;
        const stillWorks =
            typeof stored === "string" && (await bcrypt.compare(password, stored));

        if (stillWorks) {
            report.verified.push(username);
        } else {
            report.taken.push(username);
        }
    }

    return report;
}
